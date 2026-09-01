/**
 * TOML key identity, shared by the two TOML mergers (mcp-install.ts's
 * `[mcp_servers.tacendum]` table, hostconfig.ts's top-level `notify` key).
 *
 * TOML lets the SAME key be spelled many ways: `[mcp_servers.tacendum]`,
 * `[mcp_servers."tacendum"]`, `['mcp_servers'.'tacendum']`,
 * `[ mcp_servers . tacendum ]`, even `["mcp_servers"."tacendum"]` —
 * every one of them names the one table `mcp_servers.tacendum`. Both mergers
 * used to compare header TEXT, so any spelling but the bare one went
 * unrecognised and the merge appended a second definition of a key the file
 * already had — invalid TOML, in a config file OTHER tools own. Key identity
 * is a property of the PARSED path, and this module is the one place that
 * parsing lives.
 *
 * Scope, on purpose: key paths and LEXICAL LINE STRUCTURE — never value
 * semantics. The mergers are line-based precisely so the operator's
 * formatting and comments survive untouched, and a line-based merge needs
 * one more fact this module now owns: WHICH lines are syntax at all. TOML
 * values span lines — multiline basic strings ("""…"""), multiline literal
 * strings ('''…'''), reflowed arrays — and a scanner that reads every line
 * as potential syntax treats a `[mcp_servers.tacendum]` INSIDE a string as
 * a real header, splices string content, and hands the host invalid TOML
 * while reporting success. `scanTomlStructure` tracks exactly enough lexical
 * state (open strings, escape sequences, bracket depth, `#` inside vs
 * outside a string) to say whether a line BEGINS at top level; it still
 * never interprets a value.
 */

interface ParsedKeyPath {
  path: string[];
  /** Index of the first character AFTER the path (whitespace already
   * consumed), where the caller expects its `]` or `=`. */
  end: number;
}

const BARE_KEY = /^[A-Za-z0-9_-]+/;

/** The escapes a TOML basic string allows. Anything else makes the whole
 * line unparseable — and an unparseable key must never count as "absent". */
const BASIC_ESCAPES: Record<string, string> = {
  b: '\b',
  t: '\t',
  n: '\n',
  f: '\f',
  r: '\r',
  '"': '"',
  '\\': '\\',
};

function isWs(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t';
}

/** One key at `from`: bare, `"basic"` (escapes decoded — that decoding IS
 * the identity fix), or `'literal'`. Null when the text is not a key. */
function parseOneKey(text: string, from: number): { key: string; end: number } | null {
  const ch = text[from];
  if (ch === '"') {
    let key = '';
    let i = from + 1;
    while (i < text.length) {
      const c = text[i] as string;
      if (c === '"') return { key, end: i + 1 };
      if (c === '\\') {
        const esc = text[i + 1];
        if (esc !== undefined && esc in BASIC_ESCAPES) {
          key += BASIC_ESCAPES[esc] as string;
          i += 2;
          continue;
        }
        if (esc === 'u' || esc === 'U') {
          const len = esc === 'u' ? 4 : 8;
          const hex = text.slice(i + 2, i + 2 + len);
          if (!new RegExp(`^[0-9A-Fa-f]{${len}}$`).test(hex)) return null;
          try {
            key += String.fromCodePoint(Number.parseInt(hex, 16));
          } catch {
            return null; // out-of-range code point: not a TOML string
          }
          i += 2 + len;
          continue;
        }
        return null; // an escape TOML does not define
      }
      key += c;
      i += 1;
    }
    return null; // unterminated
  }
  if (ch === "'") {
    const close = text.indexOf("'", from + 1);
    if (close === -1) return null;
    return { key: text.slice(from + 1, close), end: close + 1 };
  }
  const bare = BARE_KEY.exec(text.slice(from));
  if (bare === null) return null;
  return { key: bare[0], end: from + bare[0].length };
}

/** A dotted key path starting at `from`: `a`, `a.b`, `"a" . 'b'`, … Null
 * when the text there is not a key path. */
export function parseKeyPath(text: string, from: number): ParsedKeyPath | null {
  const path: string[] = [];
  let i = from;
  for (;;) {
    while (isWs(text[i])) i += 1;
    const key = parseOneKey(text, i);
    if (key === null) return null;
    path.push(key.key);
    i = key.end;
    while (isWs(text[i])) i += 1;
    if (text[i] !== '.') return { path, end: i };
    i += 1;
  }
}

export interface TomlHeader {
  path: string[];
  /** True for `[[array.of.tables]]`. */
  array: boolean;
}

/** A whole line as a table header — `[path]` or `[[path]]`, optional
 * trailing comment. Null when the line is anything else. */
export function parseTableHeaderLine(line: string): TomlHeader | null {
  let i = 0;
  while (isWs(line[i])) i += 1;
  if (line[i] !== '[') return null;
  i += 1;
  const array = line[i] === '[';
  if (array) i += 1;
  const parsed = parseKeyPath(line, i);
  if (parsed === null) return null;
  i = parsed.end;
  if (line[i] !== ']') return null;
  i += 1;
  if (array) {
    if (line[i] !== ']') return null;
    i += 1;
  }
  while (isWs(line[i])) i += 1;
  if (i < line.length && line[i] !== '#') return null;
  return { path: parsed.path, array };
}

/** The key path on the left of a `key = value` line (the value itself is
 * not this module's business). Null for blanks, comments, headers, and
 * anything that does not read as `path =`. */
export function parseAssignmentKeyLine(line: string): string[] | null {
  let i = 0;
  while (isWs(line[i])) i += 1;
  if (i >= line.length || line[i] === '#' || line[i] === '[') return null;
  const parsed = parseKeyPath(line, i);
  if (parsed === null) return null;
  if (line[parsed.end] !== '=') return null;
  return parsed.path;
}

export function pathEquals(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((part, i) => part === b[i]);
}

/** Does `path` start with `prefix` (equality included)? */
export function pathStartsWith(path: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= path.length && prefix.every((part, i) => part === path[i]);
}

export interface TomlStructureScan {
  /** structural[i]: line i BEGINS at top level — not inside a multiline
   * string and not inside a still-open array or inline table. Only a
   * structural line can carry a header or an assignment, bound a section,
   * or take an insertion; every other line is VALUE CONTENT, whatever it
   * happens to look like. */
  structural: boolean[];
  /** Index of the first line that cannot be lexed as TOML (an unterminated
   * single-line string, a close bracket with nothing open); null when the
   * file lexes clean. A merger must refuse such a file, not guess at it. */
  malformedAt: number | null;
  /** The file ends inside an unterminated multiline string or bracket —
   * there IS no top-level position at EOF to append to. */
  openAtEof: boolean;
}

/** The cross-line lexical state `scanTomlStructure` threads: which multiline
 * string (if any) is open, and how many arrays/inline tables are. */
interface LexState {
  inString: 'ml-basic' | 'ml-literal' | null;
  arrayDepth: number;
  inlineDepth: number;
}

/**
 * Lex ONE line's worth of value text starting at `start`, mutating `st`.
 * Tracks string open/close (with basic-string escapes — a `\"` must not
 * close, a `"""` must), bracket depth, and `#` comments (only outside
 * strings). Returns true when the line is malformed TOML: a single-line
 * string left unterminated at EOL, or a close bracket with nothing open.
 */
function lexValueLine(line: string, start: number, st: LexState): boolean {
  let i = start;
  let malformed = false;
  while (i < line.length) {
    if (st.inString === 'ml-basic') {
      const ch = line[i];
      if (ch === '\\') {
        i += 2; // an escape — including \" (which must not count as a close)
        continue; // and a trailing \ (the line-continuation escape) runs off the end harmlessly
      }
      if (ch === '"') {
        let q = 1;
        while (line[i + q] === '"') q += 1;
        if (q >= 3) st.inString = null; // 1–2 quotes are content; 3+ close
        i += q;
        continue;
      }
      i += 1;
      continue;
    }
    if (st.inString === 'ml-literal') {
      if (line[i] === "'") {
        let q = 1;
        while (line[i + q] === "'") q += 1;
        if (q >= 3) st.inString = null;
        i += q;
        continue;
      }
      i += 1;
      continue;
    }
    const ch = line[i];
    if (ch === '#') return malformed; // a real comment — only outside strings
    if (ch === '"') {
      if (line[i + 1] === '"' && line[i + 2] === '"') {
        st.inString = 'ml-basic';
        i += 3;
        continue;
      }
      let j = i + 1;
      let closed = false;
      while (j < line.length) {
        if (line[j] === '\\') {
          j += 2;
          continue;
        }
        if (line[j] === '"') {
          closed = true;
          j += 1;
          break;
        }
        j += 1;
      }
      if (!closed) return true; // a single-line basic string cannot span lines
      i = j;
      continue;
    }
    if (ch === "'") {
      if (line[i + 1] === "'" && line[i + 2] === "'") {
        st.inString = 'ml-literal';
        i += 3;
        continue;
      }
      const close = line.indexOf("'", i + 1);
      if (close === -1) return true;
      i = close + 1;
      continue;
    }
    if (ch === '[') st.arrayDepth += 1;
    else if (ch === ']') {
      if (st.arrayDepth === 0) malformed = true;
      else st.arrayDepth -= 1;
    } else if (ch === '{') st.inlineDepth += 1;
    else if (ch === '}') {
      if (st.inlineDepth === 0) malformed = true;
      else st.inlineDepth -= 1;
    }
    i += 1;
  }
  return malformed;
}

/**
 * One lexical pass over the file: for every line, does it BEGIN at top
 * level? A line inside a multiline string or a reflowed array is value
 * content — `[mcp_servers.tacendum]` there is seven characters of prose,
 * not a header, and choosing it as a section boundary or an insertion point
 * is how a line-based merge corrupts a valid file while reporting success.
 *
 * Structural lines that are not assignments (headers, comments, blanks,
 * opaque garbage) never open a continuation; an assignment's value is lexed
 * from after its `=` and may leave a string or bracket open across lines.
 * Lines expose only their DELIMITER structure here — values are never
 * interpreted, which keeps this module out of the value-parser business its
 * header forswears.
 */
export function scanTomlStructure(lines: readonly string[]): TomlStructureScan {
  const structural: boolean[] = new Array<boolean>(lines.length);
  let malformedAt: number | null = null;
  const st: LexState = { inString: null, arrayDepth: 0, inlineDepth: 0 };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const isStructural = st.inString === null && st.arrayDepth === 0 && st.inlineDepth === 0;
    structural[i] = isStructural;
    let from = -1;
    if (isStructural) {
      let j = 0;
      while (isWs(line[j])) j += 1;
      if (j >= line.length || line[j] === '#' || line[j] === '[') continue; // blank/comment/header-ish: never continues
      const key = parseKeyPath(line, j);
      if (key === null || line[key.end] !== '=') continue; // opaque non-assignment: never continues
      from = key.end + 1;
    } else {
      from = 0; // still inside the previous assignment's value
    }
    if (lexValueLine(line, from, st) && malformedAt === null) malformedAt = i;
  }
  return {
    structural,
    malformedAt,
    openAtEof: st.inString !== null || st.arrayDepth > 0 || st.inlineDepth > 0,
  };
}

/**
 * Split TOML text into \r-free lines plus the ONE newline that rejoins them.
 * Null when the endings are mixed (\r\n and bare \n in one file, or a bare
 * \r anywhere): no single rejoin can then both preserve untouched lines and
 * avoid emitting mixed endings, so the caller must refuse rather than pick.
 *
 * A uniformly-CRLF file round-trips exactly: every \r sits in a \r\n pair,
 * so normalize-then-restore touches no byte that was not edited — the merge
 * must never hand the operator a whole-file line-ending diff.
 */
export function splitTomlLines(text: string): { lines: string[]; eol: '\n' | '\r\n' } | null {
  if (!text.includes('\r')) return { lines: text.split('\n'), eol: '\n' };
  if (/\r(?!\n)/.test(text) || /(^|[^\r])\n/.test(text)) return null; // bare \r, or LF mixed with CRLF
  return { lines: text.replace(/\r\n/g, '\n').split('\n'), eol: '\r\n' };
}
