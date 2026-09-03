/**
 * Split a message's words into text and link runs, so the thread can make a
 * web address tappable.
 *
 * Deliberately narrow. A run is a link only when it DECLARES itself one — a
 * bare `http://` / `https://` scheme, or a `www.` host — never a bare domain
 * (`example.com` is words until someone types the scheme; guessing turns
 * "e.g." and "node.js" into buttons). Pure: nothing here fetches, resolves,
 * or previews anything — a link preview would hand the address to a server
 * before the person chose to open it, which is exactly what an E2EE
 * messenger must not do on their behalf. */

export type LinkRun =
  | { kind: 'text'; text: string }
  | {
      kind: 'link';
      /** The address as typed, for display. */
      text: string;
      /** What to open: the typed address, with `https://` in front of a bare
       * `www.` host and the scheme lowercased. */
      url: string;
    };

/** A scheme'd address or a `www.` host, up to the next whitespace or quote. */
const LINK = /\bhttps?:\/\/[^\s<>"'`]+|\bwww\.[^\s<>"'`]+/gi;

/** Sentence punctuation that follows a link far more often than it ends one. */
const TRAILING = new Set([
  '.',
  ',',
  ';',
  ':',
  '!',
  '?',
  "'",
  '"',
  ')',
  ']',
  '}',
  '>',
]);

/**
 * The longest run that may become a link. Longer than any address anyone
 * types, and short enough that the work below is never worth measuring.
 *
 * The bound matters because this runs on the JS thread inside the bubble's
 * render, and the input is peer-controlled: one frame carries ~22 KB of
 * plaintext (MAX_PAYLOAD_B64_LENGTH), and the virtualised list re-renders a
 * row every time it scrolls back into the window. A cap here is the second
 * line of defence behind the linear trim.
 */
const MAX_LINK_LENGTH = 2048;

/** Strip trailing punctuation, keeping a `)` that closes a `(` inside the
 * address (Wikipedia-style `…/Foo_(bar)`).
 *
 * LINEAR, deliberately. This counted both paren classes over the whole
 * remaining string on every stripped character, which is quadratic: a body
 * of `http://a` followed by 22 KB of `)` froze the recipient's thread for
 * seconds per render. The counts are taken once and `closes` is
 * decremented as each `)` is given back — nothing but a `)` can be
 * stripped from the count, and `(` is not trailing punctuation, so the two
 * agree with the old reading character for character. */
function trimTrailing(raw: string): string {
  let opens = 0;
  let closes = 0;
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] === '(') opens += 1;
    else if (raw[i] === ')') closes += 1;
  }
  let end = raw.length;
  while (end > 0) {
    const last = raw[end - 1]!;
    if (!TRAILING.has(last)) break;
    if (last === ')') {
      if (opens >= closes) break;
      closes -= 1;
    }
    end -= 1;
  }
  return end === raw.length ? raw : raw.slice(0, end);
}

function urlFor(text: string): string | null {
  const lower = text.toLowerCase();
  if (lower.startsWith('http://') || lower.startsWith('https://')) {
    const schemeEnd = lower.indexOf('//') + 2;
    // Something must follow the scheme, and it must look like a host.
    const host = text.slice(schemeEnd);
    if (host.length === 0 || host.startsWith('/') || host.startsWith('.')) {
      return null;
    }
    return lower.slice(0, schemeEnd) + host;
  }
  if (lower.startsWith('www.')) {
    // `www.` alone, or `www.x` with no further dot, is not an address.
    const rest = text.slice(4);
    if (rest.length === 0 || !rest.includes('.') || rest.startsWith('.')) {
      return null;
    }
    return `https://${text}`;
  }
  return null;
}

export function linkRuns(text: string): LinkRun[] {
  const runs: LinkRun[] = [];
  if (text.length === 0) return runs;
  let cursor = 0;
  LINK.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = LINK.exec(text)) !== null) {
    const start = match.index;
    // A run this long is not an address anybody typed; treating it as words
    // is both truthful and the cheapest possible answer.
    if (match[0].length > MAX_LINK_LENGTH) continue;
    const trimmed = trimTrailing(match[0]);
    const url = trimmed.length > 0 ? urlFor(trimmed) : null;
    if (url === null) {
      // Not an address after all: the run stays words. Resume after the
      // whole match so its tail cannot be re-read as a new link.
      continue;
    }
    if (start > cursor) {
      runs.push({ kind: 'text', text: text.slice(cursor, start) });
    }
    runs.push({ kind: 'link', text: trimmed, url });
    cursor = start + trimmed.length;
    // Resume right after the trimmed address: the punctuation given back is
    // ordinary text, and the regex must not skip past it.
    LINK.lastIndex = cursor;
  }
  if (cursor < text.length) {
    runs.push({ kind: 'text', text: text.slice(cursor) });
  }
  return runs;
}
