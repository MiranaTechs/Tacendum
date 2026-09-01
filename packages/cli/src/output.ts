import { redactCredentials, redactValues } from './render.js';

/**
 * Output discipline.
 *
 * Two rules, and everything else follows from them:
 *
 *  1. **stdout is the result. stderr is the commentary.** A caller that runs
 *     `MSG=$(tacendum whoami ci-bot)` must get parseable output and nothing
 *     else, whatever went on around it. The e2e gates already depend on this
 *     split (`whoami` JSON, `calllog` JSONL, `[from] text`, `CALL ...` lines
 *     on stdout; status chatter on stderr), so it is a contract, not a taste.
 *  2. **stdout is never styled.** No colour, no cursor movement, no spinner —
 *     ever, on any terminal. Progress is an stderr concern.
 *
 * `--plain` is therefore about stderr, and it is one constraint serving two
 * audiences that are really the same audience: a
 * screen reader and a CI log both need line-at-a-time output that does not
 * rewrite itself. The transient status line below is the only thing `--plain`
 * turns off, and it is also off automatically when stderr is not a TTY (so
 * every redirect, pipe and CI run is already plain) or when NO_COLOR is set.
 *
 * The default is chosen the same way: a person watching a slow `send` on a
 * terminal gets one line that updates; nobody else ever sees it.
 *
 * ---------------------------------------------------------------------------
 * THE PRINTER INVENTORY, as of this writing, because the last note about it was
 * wrong and a note that names the wrong gap is worse than none — the next
 * reader trusts it and stops looking.
 *
 * Every method on this class puts its text through `redactCredentials`
 * (render.ts, THE CREDENTIAL CHOKEPOINT). `emit`/`line` cover stdout, results
 * and streams, `--json` and human alike; `status`/`note` cover the stderr
 * commentary. Nothing that goes out through a Reporter can carry a registered
 * credential, whoever composed the record.
 *
 * What is NOT a Reporter, and therefore still owns its own belt — RE-DERIVED
 * by reading every `process.stdout.write` and `console.log` in
 * packages/cli/src, because the previous inventory named four exceptions and
 * there were five:
 *   - the top-level error printer in main.ts, which cannot use a Reporter
 *     because it has to work when constructing one is what threw. It calls
 *     `sanitizeForTerminal`, which redacts.
 *   - `cmdDoctor`'s two arms, which redact/sanitize explicitly and say so.
 *   - the fixed-prose `console.log`s (the help text, the version banner, the
 *     safety-number lines, `mcp install`'s snippet): no server- or
 *     profile-derived value reaches them.
 *   - **the MCP transport (mcp.ts), which the last inventory missed entirely.**
 *     stdout there IS the JSON-RPC stream, so it cannot be a Reporter — a
 *     framing byte of ours would corrupt it. It was therefore serializing
 *     tool results outside every boundary this class installs, and
 *     `tacendum_whoami` returned the bearer in BOTH `content[0].text` and
 *     `structuredContent` under the same `userId === authToken` response the
 *     structured gate reproduces. mcp.ts now puts every frame through
 *     `redactValues` at its own single serialization point, which is this
 *     class's rule rather than a copy of its code.
 * Every other structured printer in main.ts (`calllog`, `gcall`, `whoami`)
 * routes through this class rather than calling `console.log` with a
 * `JSON.stringify` of its own.
 */
export class Reporter {
  readonly json: boolean;
  readonly plain: boolean;
  /** True when a transient status line is currently on screen, unterminated. */
  private pending = false;

  constructor(opts: { json: boolean; plain: boolean }) {
    this.json = opts.json;
    this.plain =
      opts.plain ||
      !process.stderr.isTTY ||
      // The de-facto standard (no-color.org). Honouring it costs nothing and
      // its absence is the kind of thing that gets a tool a bug report a year.
      Boolean(process.env.NO_COLOR) ||
      process.env.TERM === 'dumb';
  }

  private get interactive(): boolean {
    return !this.plain;
  }

  /** Clear a transient status line before anything else writes. */
  private clear(): void {
    if (this.pending) {
      process.stderr.write('\r\u001b[2K');
      this.pending = false;
    }
  }

  /**
   * The command's RESULT, on stdout. `record` is emitted under `--json`,
   * `human` otherwise — and both are the whole of stdout for that command.
   *
   * ---------------------------------------------------------------------
   * JSON FRAMING PREVENTS INJECTION, NOT DISCLOSURE.
   *
   * The credential chokepoint (render.ts) went inside `sanitizeForTerminal` on
   * the reasoning that it is the one call every server- and peer-influenced
   * string already makes on its way to a stream. True of the HUMAN path, and
   * this line was the hole in it: a structured printer calls no sanitizer at
   * all. It hands a record to `JSON.stringify`, which escapes control bytes —
   * the injection question, and the only one it was ever asked — and prints a
   * session token verbatim.
   *
   * It needed no malformed anything. `AuthResponse.userId` is a plain
   * `z.string()`, so a server may answer with the same 43-character value as
   * both `userId` and `authToken`; `register --json` then printed the bearer
   * as its result, and `whoami --json` — the shape a hook FORWARDS, so it
   * travels further than a terminal line, not less far — printed it again.
   *
   * THE REDACTION IS AT THE SERIALIZATION BOUNDARY, not at the call sites,
   * and that is the whole point: every `emit`/`line` in this package inherits
   * it, and no record added in future can bypass it by being composed
   * somewhere nobody thought to look. A rule with N call sites is a rule with
   * N+1 chances to be forgotten (render.ts says the same thing about the
   * sanitizers, and for the same reason).
   *
   * BOTH ARMS, because both are stdout. The human arm's callers mostly
   * sanitize already; "mostly" is what this file exists to stop depending on.
   *
   * THE VALUES ARE REDACTED, NOT THE DOCUMENT, and the difference is the whole
   * of the regression this line shipped. The first version of this
   * fix wrote `redactCredentials(JSON.stringify(record))`, on the reasoning
   * that one pass over the serialized text covers every field. It does — and a
   * run of a credential does not care which part of the document it lands in.
   * A 43-character token opening `12345678` shares that run with a server
   * timestamp of `1234567890123`, so `{"ts":1234567890123,…}` was printed as
   * `{"ts":[credential withheld]90123,…}`: not valid JSON, from the code whose
   * job is to protect the JSON. The server chooses BOTH the token it mints and
   * the timestamps it sends, so this was a denial of `--json` a hostile server
   * could turn on at will (test/gate.value-redaction.test.ts reproduces it
   * through the real binary).
   *
   * `redactValues` (render.ts) walks the record and redacts each string leaf
   * BEFORE the encoder runs, so a marker can only ever land inside a JSON
   * string, a number is never touched, and a replacement cannot straddle a
   * delimiter. The document is valid by construction rather than by the marker
   * table happening to contain no quote.
   */
  emit(record: Record<string, unknown>, human: string): void {
    this.clear();
    process.stdout.write(
      `${this.json ? JSON.stringify(redactValues(record)) : redactCredentials(human)}\n`,
    );
  }

  /** One line of a stream (`listen`). Same rules as `emit`. */
  line(record: Record<string, unknown>, human: string): void {
    this.emit(record, human);
  }

  /**
   * A record whose HUMAN form is the same JSON document — `calllog`'s JSONL
   * rows, `gcall`'s state dump and `whoami`'s card, all of which the e2e gates
   * parse with `json.load` whether or not `--json` was passed.
   *
   * It exists because those used to call `emit(record, JSON.stringify(record))`,
   * and `emit`'s human arm treats its argument as PROSE: it redacts the
   * serialized string, which is exactly the corruption the note above
   * describes. Passing the record on both arms puts them on the encoder path
   * in either mode, so the shape the gates actually run in is the shape that
   * is protected. A caller with genuine prose for a human still uses `emit`.
   *
   * `whoami` WAS THE LAST HOLDOUT, and it is worth naming because it is the
   * command an operator scripts and a hook forwards. It passed
   * `JSON.stringify(record, null, 2)` as the human argument, so on the default
   * path — no `--json` — the document went through `redactCredentials`, and
   * the server picks where the run lands. `AuthResponse.authToken` is a plain
   * `z.string()`: a token opening `identity` renamed `"identityKey"`, and one
   * opening `"identity` ATE THE OPENING QUOTE and made `whoami`'s stdout
   * unparseable. `MSG=$(tacendum whoami ci-bot)` is this file's own rule 1, so
   * that was a hostile server switching off the contract at will.
   *
   * `pretty` is therefore about LAYOUT ONLY, never about which path the values
   * take. Under `--json` it is ignored — a machine consumer gets the compact
   * line it has always got, byte for byte — and on the human path the SAME
   * redacted object is encoded with two-space indentation. There is one
   * redaction path and one encoder; the indent is the only difference.
   */
  emitRecord(record: Record<string, unknown>, opts: { pretty?: boolean } = {}): void {
    this.clear();
    const safe = redactValues(record);
    const text =
      opts.pretty === true && !this.json ? JSON.stringify(safe, null, 2) : JSON.stringify(safe);
    process.stdout.write(`${text}\n`);
  }

  /**
   * Progress. Transient on a terminal, one durable line otherwise, and
   * nothing at all under `--json` — a machine consumer asked for a result,
   * not a narration.
   */
  status(text: string): void {
    if (this.json) return;
    // Same boundary as `emit`, for the same reason: which STREAM a credential
    // is printed on changes nothing about whether it was printed.
    text = redactCredentials(text);
    if (this.interactive) {
      this.clear();
      process.stderr.write(`\u001b[2m${text}\u001b[0m`);
      this.pending = true;
      return;
    }
    process.stderr.write(`${text}\n`);
  }

  /** Something worth keeping: warnings, carriers, safety advisories. */
  note(text: string): void {
    this.clear();
    process.stderr.write(`${redactCredentials(text)}\n`);
  }

  // NOTE: there is no `error()` here on purpose. The failure path is the
  // top-level catch in `main.ts`, which has to work even when construction of
  // this object is what threw — so it writes to stderr directly rather than
  // depending on a Reporter that may not exist.

  /** Retire any transient line. Idempotent; safe to call on every exit path. */
  done(): void {
    this.clear();
  }
}
