/**
 * The link tokenizer: a web address is a link only when it declares itself
 * one, and the split is pure — words in, runs out, nothing fetched. */
import { linkRuns } from '../src/linkRuns';

test('plain words are one text run; an empty message is none', () => {
  expect(linkRuns('lunch tomorrow?')).toEqual([
    { kind: 'text', text: 'lunch tomorrow?' },
  ]);
  expect(linkRuns('')).toEqual([]);
});

test('a scheme’d address in the middle of a sentence splits into three runs', () => {
  expect(linkRuns('see https://example.com/a?b=1 now')).toEqual([
    { kind: 'text', text: 'see ' },
    { kind: 'link', text: 'https://example.com/a?b=1', url: 'https://example.com/a?b=1' },
    { kind: 'text', text: ' now' },
  ]);
});

test('sentence punctuation after an address is words, not part of it', () => {
  expect(linkRuns('read https://example.com/a.')).toEqual([
    { kind: 'text', text: 'read ' },
    { kind: 'link', text: 'https://example.com/a', url: 'https://example.com/a' },
    { kind: 'text', text: '.' },
  ]);
  expect(linkRuns('(https://example.com/a)')).toEqual([
    { kind: 'text', text: '(' },
    { kind: 'link', text: 'https://example.com/a', url: 'https://example.com/a' },
    { kind: 'text', text: ')' },
  ]);
  // A `)` that closes a `(` inside the address stays with it.
  expect(linkRuns('https://en.wikipedia.org/wiki/Foo_(bar)')).toEqual([
    {
      kind: 'link',
      text: 'https://en.wikipedia.org/wiki/Foo_(bar)',
      url: 'https://en.wikipedia.org/wiki/Foo_(bar)',
    },
  ]);
});

test('a www. host opens over https; the typed text is what is shown', () => {
  expect(linkRuns('www.tacendum.com')).toEqual([
    { kind: 'link', text: 'www.tacendum.com', url: 'https://www.tacendum.com' },
  ]);
  expect(linkRuns('HTTP://Example.com/Path')).toEqual([
    { kind: 'link', text: 'HTTP://Example.com/Path', url: 'http://Example.com/Path' },
  ]);
});

test('a bare domain, a bare scheme and a bare www are words', () => {
  expect(linkRuns('example.com is down, node.js too, e.g. this')).toEqual([
    { kind: 'text', text: 'example.com is down, node.js too, e.g. this' },
  ]);
  expect(linkRuns('https:// nothing')).toEqual([
    { kind: 'text', text: 'https:// nothing' },
  ]);
  expect(linkRuns('www. and www.x')).toEqual([
    { kind: 'text', text: 'www. and www.x' },
  ]);
});

test('two addresses in one message are two links', () => {
  expect(linkRuns('https://a.example/1 or https://b.example/2')).toEqual([
    { kind: 'link', text: 'https://a.example/1', url: 'https://a.example/1' },
    { kind: 'text', text: ' or ' },
    { kind: 'link', text: 'https://b.example/2', url: 'https://b.example/2' },
  ]);
});

/**
 * A hostile body must not freeze the thread. The
 * trailing-punctuation trim used to re-scan the whole remaining string for
 * parens on every stripped character — quadratic — and it runs inside the
 * bubble's render, so one message of `http://a` + 22 KB of `)` stalled the
 * recipient's list for seconds every time that row scrolled back into the
 * window. 22 000 is the plaintext a single frame can carry
 * (MAX_PAYLOAD_B64_LENGTH). */
test('a 22 KB run of trailing punctuation tokenises in microseconds, not seconds', () => {
  const parens = 'http://a' + ')'.repeat(22_000);
  const dots = 'http://a' + '.'.repeat(22_000);
  const started = Date.now();
  const a = linkRuns(parens);
  const b = linkRuns(dots);
  const elapsed = Date.now() - started;
  // Measured before the fix on this machine: ~4100 ms for the parens alone.
  expect(elapsed).toBeLessThan(200);
  // And the words survive whole: a run that long is never a link, so the
  // whole body stays text.
  expect(a.map(r => r.text).join('')).toBe(parens);
  expect(b.map(r => r.text).join('')).toBe(dots);
  expect(a.some(r => r.kind === 'link')).toBe(false);
});

test('an ordinary address with a little trailing punctuation still trims', () => {
  expect(linkRuns('https://example.com/a)))')).toEqual([
    { kind: 'link', text: 'https://example.com/a', url: 'https://example.com/a' },
    { kind: 'text', text: ')))' },
  ]);
});
