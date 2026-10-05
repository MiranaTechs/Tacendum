/**
 * THE SMART FIELD'S CLASSIFIER, as data (Start a chat, build 33).
 *
 * One field takes a Tacendum ID, a handle (the find-by-name class) or an
 * email, and says which before anything happens. Every rule here is a guard
 * against a real failure:
 *
 *  - `extractId` finds a 26-character run ANYWHERE, so the link and `@`
 *    checks run first: a long email used to make up an ID, and a link slug
 *    inside typed prose used to read as a complete ID.
 *  - `fold` maps O to 0, so "digit-led" is judged on the RAW text: "oliver"
 *    is a name, not an ID.
 *  - A run of more than 26 ID characters is TOO LONG and never trimmed: one
 *    extra character at the start or in the middle is somebody else's ID.
 *  - A paste only yields an ID from a token without `@` whose raw first
 *    character is 0-7 (every server-minted ULID starts there).
 *
 * The handle validator is injected (the screen passes the real one only while
 * the class is live), so the module itself stays pure and spells no class
 * word. The validator below is the production one.
 */

import { normalizedUsernameOrNull } from '../src/accountsUsername';
import {
  classifyReach,
  groupId,
  groupIdLines,
  insertedRun,
  smartPastedIds,
  type ClassifyOptions,
  type SelfKeys,
} from '../src/reachClassifier';

// The app's tsconfig types only `jest`; node's modules are present at
// runtime (the android.copy.divergences idiom).
const { readFileSync } = require('fs') as {
  readFileSync: (path: string, encoding: string) => string;
};
const { join } = require('path') as { join: (...parts: string[]) => string };
declare const __dirname: string;

const PEER = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
const OTHER = '01J0A2B3C4D5E6F7G8H9JKMNPQ';
const SELF = '01KYDBSSDJSPC9J0E5N2AWMJ5Y';

const MINE: SelfKeys = { userId: SELF, emails: ['me@example.com'], handle: 'alice_7' };
const NOBODY: SelfKeys = { userId: SELF, emails: [], handle: null };
const ON: ClassifyOptions = { handleShape: normalizedUsernameOrNull };
const OFF: ClassifyOptions = { handleShape: null };

const on = (raw: string, keys: SelfKeys = NOBODY) => classifyReach(raw, keys, ON);
const off = (raw: string, keys: SelfKeys = NOBODY) => classifyReach(raw, keys, OFF);

/** A link carrying an ID-sized slug, in the wrappers it is usually sent in. */
const WRAPPED_LINKS = [
  `<https://example.com/${PEER}>`,
  `(https://example.com/${PEER})`,
  `"https://example.com/${PEER}"`,
  `'https://example.com/${PEER}'`,
  `[link](https://example.com/${PEER})`,
  `see <https://example.com/${PEER}> soon`,
  `<a href="https://example.com/${PEER}">`,
  `<tacendum:${PEER}>`,
  `(ID:${PEER})`,
];

describe('the worked cases (one row each)', () => {
  test('an ID being typed in groups is an ID with a count', () => {
    expect(on('01JA 7Q4M 9X')).toEqual({
      kind: 'id',
      id: null,
      count: 10,
      problem: 'short',
      self: false,
    });
  });

  test('a lower-case ID folds to the canonical one', () => {
    expect(on(PEER.toLowerCase())).toEqual({
      kind: 'id',
      id: PEER,
      count: 26,
      problem: null,
      self: false,
    });
  });

  test('an ID that starts with the letter O is complete once all 26 characters are in (completeness clause)', () => {
    expect(on(`O${PEER.slice(1)}`)).toMatchObject({ kind: 'id', id: PEER, count: 26 });
    // Until then the same letter-led text is a name, not an ID.
    expect(on(`O${PEER.slice(1, 20)}`).kind).toBe('handle');
  });

  test('"oliver" is a name: digit-led is judged on the raw text, never the folded one', () => {
    expect(on('oliver')).toEqual({
      kind: 'handle',
      label: 'oliver',
      normalized: 'oliver',
      self: false,
    });
    expect(off('oliver')).toEqual({ kind: 'unknown' });
  });

  test('@Alice_7 drops the sigil and keeps the case in the label', () => {
    expect(on('@Alice_7')).toEqual({
      kind: 'handle',
      label: 'Alice_7',
      normalized: 'alice_7',
      self: false,
    });
  });

  test('a lone @ is a handle with nothing to find', () => {
    expect(on('@')).toEqual({ kind: 'handle', label: '', normalized: null, self: false });
  });

  test('a long email is an email: the @ is judged before any ID rule', () => {
    expect(on('christophermontgomerysmith@example.com')).toEqual({
      kind: 'email',
      label: 'christophermontgomerysmith@example.com',
      valid: true,
      self: false,
    });
  });

  test('a 26-letter name that is not 0-7-led stays a name', () => {
    expect(on('alexandermaximiliandavidso')).toMatchObject({
      kind: 'handle',
      label: 'alexandermaximiliandavidso',
    });
  });

  test('documented edge: an O-led 26-character entry that is Crockford after the fold reads as an ID', () => {
    expect(on('oliverjameswilliamsdavidxy')).toMatchObject({
      kind: 'id',
      id: '011VERJAMESW1111AMSDAV1DXY',
      count: 26,
    });
    // The sigil still reaches the name.
    expect(on('@oliverjameswilliamsdavidxy').kind).toBe('handle');
    // And with the class dark the edge is unchanged (it is an ID rule).
    expect(off('oliverjameswilliamsdavidxy').kind).toBe('id');
  });

  test('27-character O- or I-led names are names (their run is 27), never a red "27 of 26"', () => {
    for (const name of [
      'olivermontgomerywashington1',
      'isabellamariagonzalezrodrig',
      'oliverjameswilliamsdavidxyz',
    ]) {
      expect([name, on(name).kind]).toEqual([name, 'handle']);
      expect([name, off(name).kind]).toEqual([name, 'unknown']);
    }
  });

  test('the recorded trade-off: "ID" glued to an ID with no separator is a 28-character name', () => {
    expect(on(`ID${PEER}`).kind).toBe('handle');
  });

  test('"ID: <ID>" typed with a space reads as the ID: a label and a space are not a link', () => {
    expect(on(`ID: ${PEER}`)).toMatchObject({ kind: 'id', id: PEER, count: 26, problem: null });
  });

  test('a link token inside typed prose is never an ID', () => {
    expect(on(`see https://example.com/${PEER} soon`)).toEqual({ kind: 'unknown' });
  });

  test('a link wrapped in brackets or quotes is still a link: its slug is never an ID', () => {
    // The scheme used to be tested only at the token's first character, so
    // each of these read as the complete ID and offered Start chat.
    for (const raw of WRAPPED_LINKS) {
      expect([raw, on(raw)]).toEqual([raw, { kind: 'unknown' }]);
      expect([raw, off(raw)]).toEqual([raw, { kind: 'unknown' }]);
    }
    // The falsifiers: a bare ID in brackets or quotes, and "ID: <ID>" with a
    // space, carry no scheme and still read as the ID.
    for (const raw of [`(${PEER})`, `"${PEER}"`, `<${PEER}>`, `ID: ${PEER}`]) {
      expect([raw, on(raw)]).toEqual([
        raw,
        { kind: 'id', id: PEER, count: 26, problem: null, self: false },
      ]);
    }
  });

  test('a scheme glued to an ID is a link, never an address (the bare-ID guardrail)', () => {
    for (const raw of [
      `ID:${PEER}`,
      `tacendum:${PEER}`,
      `WIFI:S:home;T:WPA;P:${PEER};;`,
      `https://example.com/${PEER}`,
      `otpauth://totp/x?secret=${PEER}`,
    ]) {
      expect([raw, on(raw)]).toEqual([raw, { kind: 'unknown' }]);
    }
  });

  test('emails take the server’s own light shape; mailto: is dropped from the label', () => {
    expect(on('mira@')).toEqual({ kind: 'email', label: 'mira@', valid: false, self: false });
    expect(on('mira@x')).toEqual({ kind: 'email', label: 'mira@x', valid: true, self: false });
    expect(on('mailto:Mira@X.com')).toEqual({
      kind: 'email',
      label: 'Mira@X.com',
      valid: true,
      self: false,
    });
  });

  test('a short ID inside prose is judged by its own token: 25 of 26, never "the letter U"', () => {
    expect(on(`My Tacendum ID is ${PEER.slice(0, 25)}`)).toEqual({
      kind: 'id',
      id: null,
      count: 25,
      problem: 'short',
      self: false,
    });
    expect(on(`My Tacendum ID is ${PEER}`)).toMatchObject({ kind: 'id', id: PEER });
  });

  test('a U is reported, never folded to another ID', () => {
    expect(on(`${PEER.slice(0, 25)}U`)).toEqual({
      kind: 'id',
      id: null,
      count: 26,
      problem: 'u',
      self: false,
    });
  });

  test('a delimited glued prefix still works: id-<ID>', () => {
    expect(on(`id-${PEER}`)).toMatchObject({ kind: 'id', id: PEER, count: 26 });
  });

  test('a letter-led 27-character run with an ID inside it is a name, never that ID', () => {
    expect(on(`X${PEER}`)).toMatchObject({ kind: 'handle', label: `X${PEER}` });
  });

  test('prose, a dotted name and a formatted phone number are none of the three', () => {
    for (const raw of ['see you soon', 'alice.smith', '+1 555 123 4567']) {
      expect([raw, on(raw)]).toEqual([raw, { kind: 'unknown' }]);
    }
  });

  test('documented edge: a bare digit phone number reads as a partial ID while the phone class is dark', () => {
    expect(on('5551234567')).toEqual({
      kind: 'id',
      id: null,
      count: 10,
      problem: 'short',
      self: false,
    });
  });

  test('nothing at all is empty', () => {
    expect(on('')).toEqual({ kind: 'empty' });
    expect(on('   ')).toEqual({ kind: 'empty' });
  });
});

describe('a run of more than 26 ID characters is too long, and is never trimmed', () => {
  test('one extra character at the end, in the middle, or in a grouped entry', () => {
    const cases = [
      `${PEER}X`,
      `${PEER.slice(0, 8)}Q${PEER.slice(8)}`,
      '01BX 5ZZK BKAC TAV9 WEVG EMMV RZX',
    ];
    for (const raw of cases) {
      expect([raw, on(raw)]).toEqual([
        raw,
        { kind: 'id', id: null, count: 27, problem: 'long', self: false },
      ]);
    }
  });

  test('the falsifier: the same text one character shorter is the complete ID', () => {
    expect(on('01BX 5ZZK BKAC TAV9 WEVG EMMV RZ')).toMatchObject({ id: PEER });
  });
});

describe('with the class dark (pin OFF) nothing is ever a handle', () => {
  test('@alice and alice_7 are unknown', () => {
    expect(off('@alice')).toEqual({ kind: 'unknown' });
    expect(off('alice_7')).toEqual({ kind: 'unknown' });
  });

  test('IDs and emails are unchanged', () => {
    expect(off(PEER)).toMatchObject({ kind: 'id', id: PEER });
    expect(off('mira@x.com')).toMatchObject({ kind: 'email', valid: true });
  });
});

describe('"That’s you": the self keys', () => {
  test('your own ID in any case or grouping', () => {
    expect(on(SELF, MINE)).toMatchObject({ kind: 'id', id: SELF, self: true });
    expect(on('01ky dbss djsp c9j0 e5n2 awmj 5y', MINE)).toMatchObject({
      kind: 'id',
      id: SELF,
      self: true,
    });
    expect(on(PEER, MINE)).toMatchObject({ kind: 'id', self: false });
  });

  test('your own verified email in any case', () => {
    expect(on('ME@Example.com', MINE)).toEqual({
      kind: 'email',
      label: 'ME@Example.com',
      valid: true,
      self: true,
    });
    expect(on('mira@example.com', MINE)).toMatchObject({ self: false });
  });

  test('your own handle through @Handle, and bare', () => {
    expect(on('@Alice_7', MINE)).toMatchObject({ kind: 'handle', self: true });
    expect(on('alice_7', MINE)).toMatchObject({ kind: 'handle', self: true });
    expect(on('@alice_8', MINE)).toMatchObject({ kind: 'handle', self: false });
  });
});

describe('smartPastedIds: the gated paste reader', () => {
  const SHARED = `My Tacendum ID:\n${PEER}\nAdd me in Tacendum → Start a chat.`;
  const paste = (raw: string, live = true) =>
    smartPastedIds(raw, SELF, live ? normalizedUsernameOrNull : null);

  test('the shared three-line message, an ID in fours, a lower-case ID in prose, a bracketed or dashed token', () => {
    for (const raw of [
      SHARED,
      '01BX 5ZZK BKAC TAV9 WEVG EMMV RZ',
      `here you go: ${PEER.toLowerCase()} — see you`,
      `(${PEER})`,
      '01BX-5ZZK-BKAC-TAV9-WEVG-EMMV-RZ',
      `reach me at mira@x.com or ${PEER}`,
      `id-${PEER}`,
      `id: ${PEER}`,
    ]) {
      expect([raw, paste(raw)]).toEqual([raw, { ids: [PEER], inUriOnly: false, fill: null }]);
    }
  });

  test('two IDs are refused as more than one; an ID only inside a link is refused as a link', () => {
    expect(paste(`${PEER} or ${OTHER}`)).toEqual({
      ids: [PEER, OTHER],
      inUriOnly: false,
      fill: null,
    });
    expect(paste(`https://example.com/${PEER}`)).toEqual({
      ids: [],
      inUriOnly: true,
      fill: null,
    });
  });

  test('a link wrapped in brackets or quotes is refused as a link, never read as an ID', () => {
    for (const raw of WRAPPED_LINKS) {
      expect([raw, paste(raw)]).toEqual([raw, { ids: [], inUriOnly: true, fill: null }]);
    }
    // The falsifier: the same ID in brackets or quotes with no scheme is read.
    for (const raw of [`(${PEER})`, `"${PEER}"`, `<${PEER}>`]) {
      expect([raw, paste(raw)]).toEqual([raw, { ids: [PEER], inUriOnly: false, fill: null }]);
    }
  });

  test('GATE 1 and 2: a long email and a 27-letter name never make up an ID', () => {
    expect(paste('christophermontgomerysmith@example.com')).toEqual({
      ids: [],
      inUriOnly: false,
      fill: null,
    });
    expect(paste('alexandermaximiliandavidson')).toEqual({
      ids: [],
      inUriOnly: false,
      fill: null,
    });
  });

  test('GATE 3: one character too many fills nothing (the old reader filled somebody else’s ID)', () => {
    for (const raw of [`${PEER}X`, `X${PEER}`, `${PEER.slice(0, 8)}Q${PEER.slice(8)}`]) {
      expect([raw, paste(raw)]).toEqual([raw, { ids: [], inUriOnly: false, fill: null }]);
    }
  });

  test('prose with no ID, or a short one, is typing', () => {
    expect(paste('see you soon')).toEqual({ ids: [], inUriOnly: false, fill: null });
    expect(paste(`My Tacendum ID is ${PEER.slice(0, 25)}`)).toEqual({
      ids: [],
      inUriOnly: false,
      fill: null,
    });
  });

  test('your own ID beside exactly one other fills the other; alone it is yours; beside two others it is refused', () => {
    expect(paste(`Mine: ${SELF} theirs: ${PEER}`).ids).toEqual([PEER]);
    expect(paste(SELF).ids).toEqual([SELF]);
    expect(paste(`${SELF} ${PEER} ${OTHER}`).ids).toEqual([PEER, OTHER]);
  });

  test('a paste with no ID fills its one email token, case kept', () => {
    expect(paste('Email: lena@studio.co').fill).toBe('lena@studio.co');
    expect(paste('reach me at <mira@x.com>.').fill).toBe('mira@x.com');
    expect(paste('mailto:Lena@Studio.co').fill).toBe('Lena@Studio.co');
  });

  test('two candidates, a bare email, or a URI-shaped token fill nothing', () => {
    expect(paste('a@x.com or b@y.com').fill).toBeNull();
    expect(paste('lena@studio.co').fill).toBeNull();
    expect(paste('Email:lena@studio.co').fill).toBeNull();
  });

  test('one @handle in a sentence fills it only while the class is live', () => {
    expect(paste('My username is @mira_k, add me').fill).toBe('@mira_k');
    expect(paste('My username is @mira_k, add me', false).fill).toBeNull();
  });
});

describe('insertedRun: what one change inserted', () => {
  test('a keystroke inserts one character, a deletion none, a one-character replacement one', () => {
    expect(insertedRun('abc', 'abXc')).toBe('X');
    expect(insertedRun('abc', 'ab')).toBe('');
    expect(insertedRun('x', 'y')).toBe('y');
    expect(insertedRun('01B', '01BX')).toBe('X');
  });

  test('select-all and paste over a text that shares no first or last character is the whole new text', () => {
    expect(insertedRun('see you', OTHER)).toBe(OTHER);
  });

  test('a 26-character paste over the 32-character grouped value is a paste, not typing', () => {
    expect(insertedRun(groupId(PEER), OTHER).length).toBeGreaterThan(1);
  });

  test('autocorrect "teh " → "the " inserts two characters', () => {
    expect(insertedRun('teh ', 'the ')).toBe('he');
  });
});

describe('the ID in fours', () => {
  test('groupId reads one way, groupIdLines breaks after the fourth group', () => {
    expect(groupId(PEER)).toBe('01BX 5ZZK BKAC TAV9 WEVG EMMV RZ');
    expect(groupIdLines(PEER)).toBe('01BX 5ZZK BKAC TAV9\nWEVG EMMV RZ');
  });
});

describe('purity', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'reachClassifier.ts'), 'utf8');

  test('imports only ./peerId and @tacendum/shared: no react-native, api or db', () => {
    const specifiers = new Set(
      Array.from(src.matchAll(/from '([^']+)'/g), match => match[1]),
    );
    expect(specifiers).toEqual(new Set(['./peerId', '@tacendum/shared']));
  });

  test('never spells the class word, comments included (the census reads every line)', () => {
    expect(/username/i.test(src)).toBe(false);
  });
});
