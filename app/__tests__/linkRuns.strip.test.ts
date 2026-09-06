/**
 * The tracking tail comes off the address that OPENS, and never off the
 * address you SEE.
 *
 * `linkRuns.ts` already refuses to hand an address to a server on the
 * person's behalf — "a link preview would hand the address to a server
 * before the person chose to open it". Dropping the parameters that tell a
 * site which message you arrived from is the same argument, one step later.
 *
 * The asymmetry is the whole design and it is what these cases pin: the
 * `text` of a link run is byte-identical to what the sender typed, always,
 * because rewriting it would be lying about what they sent.
 */
import { linkRuns, stripTracking } from '../src/linkRuns';

describe('stripTracking, on its own', () => {
  it('drops every parameter on the fixed list and keeps the rest, in order', () => {
    expect(
      stripTracking(
        'https://example.com/a?utm_source=news&id=7&fbclid=xyz&q=cats&gclid=1&mc_eid=2&igshid=3&si=4',
      ),
    ).toBe('https://example.com/a?id=7&q=cats');
  });

  it('drops the ? when nothing survives, and keeps the path', () => {
    expect(stripTracking('https://example.com/a?utm_source=news')).toBe(
      'https://example.com/a',
    );
    expect(stripTracking('https://example.com/?fbclid=x&utm_medium=y')).toBe(
      'https://example.com/',
    );
  });

  it('leaves an address with no tracking byte-for-byte alone', () => {
    expect(stripTracking('https://example.com/a?b=1')).toBe(
      'https://example.com/a?b=1',
    );
    expect(stripTracking('https://example.com/a')).toBe('https://example.com/a');
    expect(stripTracking('https://example.com/a#top')).toBe(
      'https://example.com/a#top',
    );
  });

  it('keeps the fragment, whether or not the query survives', () => {
    expect(stripTracking('https://example.com/a?utm_source=n#top')).toBe(
      'https://example.com/a#top',
    );
    expect(stripTracking('https://example.com/a?id=7&utm_source=n#top')).toBe(
      'https://example.com/a?id=7#top',
    );
  });

  it('leaves ref and ref_src alone — sometimes they are functional', () => {
    expect(stripTracking('https://example.com/a?ref=friend&ref_src=twsrc')).toBe(
      'https://example.com/a?ref=friend&ref_src=twsrc',
    );
  });

  it('matches a parameter by name, not by substring', () => {
    // `si` is on the list; `site` and `psi` are not, and a value that
    // happens to read like a tracking name is not a name.
    expect(stripTracking('https://example.com/a?site=7&psi=8&x=si')).toBe(
      'https://example.com/a?site=7&psi=8&x=si',
    );
  });

  it('handles a valueless parameter and an empty query', () => {
    expect(stripTracking('https://example.com/a?utm_source&keep')).toBe(
      'https://example.com/a?keep',
    );
    expect(stripTracking('https://example.com/a?')).toBe('https://example.com/a');
  });

  it('returns the input unchanged when the work throws', () => {
    // Two falsifiers, because the guard has to cover both ends of the work.
    //
    // FIRST CALL. `stripTracking` reaches for `indexOf('#')` before anything
    // else, so this object throws on the very first thing the function does.
    const hostile = {
      toString: () => 'https://example.com/a?utm_source=n',
      indexOf() {
        throw new Error('no');
      },
    } as unknown as string;
    expect(stripTracking(hostile)).toBe(hostile);

    // DEEPEST CALL. This one answers `indexOf` and `slice` like a string —
    // no fragment, a query starting at 21 — and only throws where the pairs
    // are actually split, which is the last place the guard has to reach.
    // Without the try/catch the returned value would not be this object.
    const deep = {
      indexOf: (needle: string) => (needle === '#' ? -1 : 21),
      slice: (from: number) =>
        from === 0
          ? 'https://example.com/a'
          : ({
              split() {
                throw new Error('no');
              },
            } as unknown as string),
    } as unknown as string;
    expect(stripTracking(deep)).toBe(deep);

    // …and that shape really does reach `split`: the identical object with a
    // WORKING split comes back stripped. Without this, the case above would
    // prove nothing the first falsifier did not already prove.
    const reached = {
      indexOf: (needle: string) => (needle === '#' ? -1 : 21),
      slice: (from: number) =>
        from === 0
          ? 'https://example.com/a'
          : ({
              split: () => ['utm_source=n', 'id=7'],
            } as unknown as string),
    } as unknown as string;
    expect(stripTracking(reached)).toBe('https://example.com/a?id=7');
  });
});

describe('what a link run carries', () => {
  it('the url loses the tags and the text keeps them, exactly as typed', () => {
    const typed = 'https://example.com/a?utm_source=news&id=7';
    expect(linkRuns(`see ${typed} now`)).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'link', text: typed, url: 'https://example.com/a?id=7' },
      { kind: 'text', text: ' now' },
    ]);
  });

  it('an address that is nothing but tracking still opens', () => {
    expect(linkRuns('www.example.com/a?fbclid=x')).toEqual([
      {
        kind: 'link',
        text: 'www.example.com/a?fbclid=x',
        url: 'https://www.example.com/a',
      },
    ]);
  });
});
