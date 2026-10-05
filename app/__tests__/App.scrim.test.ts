/**
 * App.tsx carries no hard-coded colour.
 *
 * The in-call Add picker used to sit under a translucent scrim literal —
 * the one colour literal in the file, and the one translucent scrim
 * in the app (the project rule: no translucent scrims anywhere; the emoji
 * rail is the precedent). It now sits on an opaque paper sheet from the
 * theme's tokens with a hairline seam above it. No suite mounts the group-add
 * picker, so the pin is on the SOURCE: an `rgba(` or hex literal returning
 * to App.tsx fails here. */
// A module, not a script: a bare test file shares one global scope with
// every other bare one, and privacy.manifest.test.ts declares this name too.
export {};

// The app's tsconfig types only jest (the copy-census suite's precedent).
const { readFileSync } = require('fs') as {
  readFileSync: (path: string, encoding: string) => string;
};

const source = readFileSync(`${__dirname}/../App.tsx`, 'utf8');

test('App.tsx has no rgba( literal — colour comes from the theme tokens', () => {
  expect(source).not.toMatch(/rgba\(/);
});

test('App.tsx has no hex colour literal either', () => {
  expect(source).not.toMatch(/'#[0-9a-fA-F]{3,8}'/);
});

/**
 * …and the opaque paper is on the PICKER'S OWN SHEET, not on the full-screen
 * layer above the call. Painting `StyleSheet.absoluteFill` with `paperLayer`
 * blanked the whole group call — every tile, every control — behind a paper
 * field, and left the hairline seam separating paper from paper. Still a
 * source pin: no suite mounts the group-add picker. */
const addPicker = (() => {
  const start = source.indexOf('{groupView && groupAdding && (');
  const end = source.indexOf('<CallPicker', start);
  if (start < 0 || end < 0) throw new Error('group Add picker block not found');
  return source.slice(start, end);
})();

test('the full-screen Add layer is transparent — no paper token on it', () => {
  const layer = addPicker.slice(0, addPicker.indexOf('<View', addPicker.indexOf('<View') + 1));
  expect(layer).toContain('StyleSheet.absoluteFill');
  expect(layer).not.toContain('paperLayer');
});

test('the Add sheet itself carries the paper token and the hairline seam', () => {
  const sheet = addPicker.slice(addPicker.indexOf('<View', addPicker.indexOf('<View') + 1));
  expect(sheet).toContain('t.color.paperLayer');
  expect(sheet).toContain('borderTopWidth: t.hairline');
});
