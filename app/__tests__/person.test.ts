import {
  monogram,
  personName,
  personRef,
  sanitizeDisplayName,
  shortId,
} from '../src/person';

/**
 * Render hardening for peer-chosen names. A peer's
 * card is free text, and until now every screen painted it verbatim: bidi
 * overrides could reverse neighbouring text, zero-width characters could
 * make two visually identical names distinct strings, and controls could
 * do anything a terminal ever feared. These tests pin the one chokepoint
 * that stops all of that at display time — while leaving every honest name
 * byte-identical, joined emoji included.
 *
 * Every hostile character is BUILT from its code point ON PURPOSE: the
 * point of these characters is being invisible, which makes a literal one
 * in a test file unreviewable.
 */

const cp = (...codes: number[]) => String.fromCodePoint(...codes);

// Bidi embedding/override marks U+202A..U+202E (LRE RLE PDF LRO RLO).
const LRE = cp(0x202a);
const RLE = cp(0x202b);
const PDF = cp(0x202c);
const LRO = cp(0x202d);
const RLO = cp(0x202e);
// Bidi isolates U+2066..U+2069 (LRI RLI FSI PDI).
const LRI = cp(0x2066);
const RLI = cp(0x2067);
const FSI = cp(0x2068);
const PDI = cp(0x2069);
// Zero-width space and direction marks; the joiner that must SURVIVE.
const ZWSP = cp(0x200b);
const LRM = cp(0x200e);
const RLM = cp(0x200f);
const ZWJ = cp(0x200d);

const PEER = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

describe('sanitizeDisplayName', () => {
  it('strips bidi embedding and override marks (U+202A–U+202E)', () => {
    // The classic RLO spoof: everything after U+202E renders reversed, so a
    // name can display as something it never was.
    expect(sanitizeDisplayName(`evil${RLO}gpj.txt`)).toBe('evilgpj.txt');
    expect(sanitizeDisplayName(`${LRE}a${RLE}b${PDF}c${LRO}d${RLO}e`)).toBe(
      'abcde',
    );
  });

  it('strips bidi isolate marks (U+2066–U+2069)', () => {
    expect(sanitizeDisplayName(`${LRI}a${RLI}b${FSI}c${PDI}d`)).toBe('abcd');
  });

  it('strips zero-width space and direction marks (U+200B/U+200E/U+200F)', () => {
    // A zero-width-prefixed "Admin" renders exactly like "Admin" while
    // comparing unequal — the impersonation primitive.
    expect(sanitizeDisplayName(`${ZWSP}Ad${LRM}min${RLM}`)).toBe('Admin');
  });

  it('keeps U+200D so joined emoji stay joined', () => {
    // Woman-technologist and the joined family: tear the ZWJ out and they
    // fall apart into their component heads.
    const family = cp(0x1f468) + ZWJ + cp(0x1f469) + ZWJ + cp(0x1f467);
    expect(sanitizeDisplayName(family)).toBe(family);
    const technologist = `${cp(0x1f9d1)}${ZWJ}${cp(0x1f4bb)} Sam`;
    expect(sanitizeDisplayName(technologist)).toBe(technologist);
  });

  it('strips C0 and C1 controls', () => {
    // NUL, BEL, ESC from C0; DEL; NEL and APC from C1.
    const dirty =
      `a${cp(0x00)}b${cp(0x07)}c${cp(0x1b)}` +
      `d${cp(0x7f)}e${cp(0x85)}f${cp(0x9f)}g`;
    expect(sanitizeDisplayName(dirty)).toBe('abcdefg');
  });

  it('collapses whitespace runs and trims', () => {
    expect(sanitizeDisplayName('  Maya \t\n  Ruiz  ')).toBe('Maya Ruiz');
  });

  it('turns an embedded newline into a space, not a deletion', () => {
    // A pasted two-line name should read as two words, never fuse into one.
    expect(sanitizeDisplayName('Maya\nRuiz')).toBe('Maya Ruiz');
  });

  it('leaves plain names byte-identical', () => {
    for (const name of [
      'Maya Ruiz',
      "O'Brien-Smith",
      'Ægir Ñandú 王小明',
      `mum ${cp(0x2764)}${cp(0xfe0f)}`, // red heart — the variation selector survives
    ]) {
      expect(sanitizeDisplayName(name)).toBe(name);
    }
  });

  it('answers the empty string for nullish or mark-only input', () => {
    expect(sanitizeDisplayName(null)).toBe('');
    expect(sanitizeDisplayName(undefined)).toBe('');
    expect(sanitizeDisplayName(`${RLO}${ZWSP} ${cp(0x07)}`)).toBe('');
  });
});

describe('the render chokepoints', () => {
  it('personName renders the sanitized form of whichever layer wins', () => {
    expect(personName(PEER, `Helen${RLO} R.`, null)).toBe('Helen R.');
    expect(personName(PEER, 'Helen R.', `${ZWSP}Mum`)).toBe('Mum');
  });

  it('a name that is nothing but marks falls through, layer by layer', () => {
    // Sanitized-empty must behave exactly like absent: an all-invisible
    // localName cannot suppress the shared card, and an all-invisible card
    // cannot suppress the id fallback (a blank row where a person should be).
    expect(personName(PEER, 'Helen R.', `${RLO}${ZWSP}`)).toBe('Helen R.');
    expect(personName(PEER, `${RLM}${RLM}`, RLO)).toBe(shortId(PEER));
  });

  it('personRef falls back to the pronoun when the name sanitizes away', () => {
    expect(personRef(PEER, `${ZWSP}${ZWSP}`, null)).toBe('them');
    expect(personRef(PEER, `Helen${LRI} R.${PDI}`, null)).toBe('Helen R.');
  });

  it('monogram cannot be led by an invisible character', () => {
    // Initials must come from what the eye sees: a zero-width prefix is not
    // a first word, and a mark-only name is no name at all.
    expect(monogram(PEER, `${ZWSP}Maya ${RLO}Ruiz`, null)).toBe('MR');
    expect(monogram(PEER, `${RLO}${ZWSP}`, null)).toBe(
      monogram(PEER, null, null),
    );
  });

  it('plain layers render byte-identical through every chokepoint', () => {
    expect(personName(PEER, 'Helen R.', 'Mum')).toBe('Mum');
    expect(personRef(PEER, 'Helen R.', null)).toBe('Helen R.');
    expect(monogram(PEER, 'Maya Ruiz', null)).toBe('MR');
  });
});

/**
 * The defect: the chokepoints were in place, but the peer
 * profile's hero read the card straight off the row — `(displayName ??
 * '').trim()` — and painted it raw, as did the photo viewer's sender slot
 * and the thread's Quiet Room. The idiom is the bypass; this pins its
 * absence from every screen, ui piece, and the call module (the system call
 * UI paints a room name), so a future reader that wants a name goes through
 * `sanitizeDisplayName` or the readers built on it.
 */
describe('the raw-read idiom is gone from the render surfaces', () => {
  // The app's tsconfig types only `jest`; node's modules are present at
  // runtime (the android.copy.divergences idiom).
  const { readFileSync, readdirSync } = require('fs') as {
    readFileSync: (path: string, encoding: string) => string;
    readdirSync: (path: string) => string[];
  };
  const { join } = require('path') as { join: (...parts: string[]) => string };
  const SRC = join(__dirname, '..', 'src');
  const ROOTS = ['screens', 'ui', 'call'];
  /** A card, a label, or an anchor name trimmed straight off the row. */
  const RAW_READ = /(displayName|localName|\bname)(\?\.trim\(\)| \?\? ''\)\.trim\(\))/;

  it('no screen, ui piece, or call module trims a card or anchor name straight off the row', () => {
    const hits: string[] = [];
    for (const root of ROOTS) {
      const dir = join(SRC, root);
      for (const file of readdirSync(dir).filter(f => /\.tsx?$/.test(f))) {
        readFileSync(join(dir, file), 'utf8')
          .split('\n')
          .forEach((line, i) => {
            if (RAW_READ.test(line)) hits.push(`${root}/${file}:${i + 1}: ${line.trim()}`);
          });
      }
    }
    expect(hits).toEqual([]);
  });
});
