/**
 * THE 5.1.2(i) / ART. 50 DISCLOSURE SENTENCE, TIED TO ITS DOCUMENTED HOME.
 *
 * docs/AI-DISCLOSURE.md section 1 says it plainly: that file is the sentence's single
 * home, and every surface quotes it VERBATIM — "a family of almost-identical
 * sentences is how a claim drifts until one of its copies is false (page copy
 * has gone live false twice in this repo's history)". A constant alone cannot
 * enforce that: the constant and the doc are two files, and two files drift.
 *
 * So this test reads the doc. It extracts the blockquote from
 * docs/AI-DISCLOSURE.md at run time and asserts the shipped constant equals it
 * byte for byte, and it ALSO pins those bytes as a literal here — the doc
 * check catches a code edit, the literal catches an edit to BOTH that quietly
 * moves the claim. Paraphrase one word in either place and this file goes red.
 *
 * Deliberately in the app workspace and NOT parameterised by a helper: the
 * whole point is that the assertion carries the sentence's bytes where a
 * reviewer reads them.
 */

// The app's tsconfig types only `jest`, so node's modules are absent from the
// type environment though present at runtime — the same idiom version.test.ts
// and privacy.manifest.test.ts use to read repo files.
const { readFileSync } = require('fs') as {
  readFileSync: (path: string, encoding: string) => string;
};
const { join } = require('path') as { join: (...parts: string[]) => string };
declare const __dirname: string;

import { AI_DISCLOSURE_SENTENCE, MACHINE_COPY } from '../src/machine';

const DOC = join(__dirname, '..', '..', 'docs', 'AI-DISCLOSURE.md');

/**
 * The blockquote, unwrapped. The doc hard-wraps its prose, so the sentence
 * lives across two `> ` lines inside markdown bold and straight quotes. The
 * extraction is deliberately narrow — it reads section 1 and refuses to fall back to
 * any other quotation in the file, so a sentence MOVED out of it fails loudly
 * instead of silently matching some neighbouring blockquote.
 */
function canonicalSentenceFromDoc(): string {
  const doc: string = readFileSync(DOC, 'utf8');
  const section = doc
    .split(/^## /m)
    .find((s: string) => s.startsWith('1. The canonical sentence'));
  if (section === undefined) {
    throw new Error(
      'docs/AI-DISCLOSURE.md no longer carries section 1 — the home moved',
    );
  }
  const quoted = section
    .split('\n')
    .filter((line: string) => line.startsWith('> '))
    .map((line: string) => line.slice(2).trim());
  if (quoted.length === 0) throw new Error('section 1 carries no blockquote');
  return quoted
    .join(' ')
    .replace(/^\*\*"/, '')
    .replace(/"\*\*$/, '');
}

describe('the canonical AI-disclosure sentence', () => {
  it('is EXACTLY these bytes — the pin a reviewer reads', () => {
    // Straight apostrophe, not the app's usual typographic one: the doc is the
    // home and the doc writes `Tacendum's`. Verbatim outranks house style.
    expect(AI_DISCLOSURE_SENTENCE).toBe(
      "Replies you send are delivered to the AI provider through a client running on your machine; " +
        "Tacendum's servers relay message ciphertext, not plaintext.",
    );
  });

  it('equals the disclosure sentence as written', () => {
    expect(AI_DISCLOSURE_SENTENCE).toBe(canonicalSentenceFromDoc());
  });

  it('the extractor really reads the doc (it fails on a paraphrase, not on anything)', () => {
    // The drift test is only worth its line count if the comparison can fail.
    // Mutate one word of the doc's own text in memory and the equality must
    // break — otherwise the assertion above is comparing a value to itself.
    const paraphrased = canonicalSentenceFromDoc().replace(
      'through a client running on your machine',
      'through a local client',
    );
    expect(paraphrased).not.toBe(AI_DISCLOSURE_SENTENCE);
  });

  it('the adopt surface QUOTES the constant rather than re-typing it', () => {
    // Both halves. `toBe` alone would pass vacuously if the constant went
    // missing (undefined === undefined), which is exactly the state this
    // suite was first run in.
    expect(MACHINE_COPY.disclosure).toContain('relay message ciphertext, not plaintext.');
    expect(MACHINE_COPY.disclosure).toBe(AI_DISCLOSURE_SENTENCE);
  });
});
