import { CliError, EXIT } from './exit.js';

/**
 * Argument parsing.
 *
 * What this replaces, and why it is worth a module. The proof client bound
 * positionals by index off `process.argv` and read flags with
 * `args.indexOf(flag) + 1`, which had three failure modes that a person only
 * ever meets in production:
 *
 *  - `cli listen --calls alice` bound `name = '--calls'` and then died inside
 *    the store layer with `invalid client name: "--calls"`. Flag order was
 *    load-bearing and entirely unchecked.
 *  - `--seconds abc` became `Number('abc')` -> NaN -> `setTimeout(NaN)`, which
 *    fires IMMEDIATELY. A typo turned an 18-second listener into a no-op that
 *    exited 0, which is the shape of a green test that tested nothing.
 *  - an unknown flag was silently ignored, so `--titel "build failed"` sent a
 *    notification with no title and reported success.
 *
 * All three are now refusals with EXIT.USAGE, which is the code that means
 * "retrying these arguments cannot help".
 */

export interface FlagSpec {
  /** Flags that take the following argv entry as their value. */
  value?: readonly string[];
  /** Flags that are present-or-absent. */
  boolean?: readonly string[];
}

export interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | true>;
}

/** Accepted by every command, so each spec does not have to repeat them. */
export const GLOBAL_BOOLEAN = ['--json', '--plain', '--help', '-h'] as const;

/**
 * How much of a rejected argv entry may appear in an error.
 *
 * A dash-leading entry is USUALLY a mistyped flag, and naming it is the whole
 * value of the error — `unknown option --titel` is instantly fixable. But it
 * is SOMETIMES a message body: `tacendum send ci me "--token=..."` with no
 * `--` terminator hands the parser plaintext, and that error goes to stderr
 * and into --json output, i.e. into hook and CI logs, which is exactly where
 * a message payload may never appear.
 *
 * The rule is an ALLOWLIST, not a shape test — see `KNOWN_FLAGS`. The `--`
 * hint is always appended, because whoever hit this is one terminator away
 * from the send working.
 */
const MAX_REJECTED_CHARS = 24;

/** What a flag NAME can look like: dashes, then one word of letters, digits
 * and hyphens. Anything else is not a flag anyone could have meant to type. */
const FLAG_NAME_RE = /^--?[A-Za-z0-9][A-Za-z0-9-]*$/;

const HINT = 'if this was a message body, put -- before it';

/**
 * Every flag this CLI knows, in any command. A rejected token is echoed ONLY
 * if it is a near-miss of one of these.
 *
 * Shape alone was not enough: `-A1b2C3d4E5f6G7h8I9j0`
 * is flag-shaped, short, has no '=' and no whitespace — and is a plausible
 * secret. Since the whole value of the message is "you typed a flag that does
 * not exist", the only text worth echoing is text that resembles a real flag,
 * and an allowlist is the one rule that cannot be talked past.
 */
const KNOWN_FLAGS = [
  '--json', '--plain', '--help', '-h', '--title', '--seconds', '--ice', '--peer',
  '--limit', '--account', '--host', '--write', '--drain', '--integration',
  '--video', '--unread', '--peek', '--purge', '--auto-answer', '--auto-decline',
  '--calls', '--version', '--everyone', '--attach', '--save-dir',
] as const;

/** Cheap edit-distance ceiling: is `a` within one or two typos of `b`? */
function nearMiss(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 2) return false;
  // Count positions that differ after aligning from both ends — enough to
  // catch --titel/--title, --jsn/--json, --acount/--account.
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let j = 0;
  while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  return a.length - i - j <= 2 && b.length - i - j <= 2;
}

function describeRejected(arg: string): string {
  // Cut at the first whitespace AND at the first '=' before deciding: prose
  // loses everything past its first space, and `--token=hunter2` reduces to
  // `--token` — the name is the diagnosable half, the value is the secret.
  const head = (arg.split(/\s/, 1)[0] ?? '').split('=', 1)[0] ?? '';
  const echoable =
    FLAG_NAME_RE.test(head) &&
    head.length <= MAX_REJECTED_CHARS &&
    KNOWN_FLAGS.some((known) => nearMiss(head.toLowerCase(), known));
  // Anything else is treated as a message body and never appears — not even
  // truncated, since the first 24 characters of a secret are still 24
  // characters of a secret.
  if (!echoable) return `(not shown — ${HINT})`;
  return `${head} (${HINT})`;
}

/**
 * Parse `argv` after the command word.
 *
 * `--` ends flag parsing: everything after it is a positional. Message bodies
 * are arbitrary text and a build log can start with a dash, so without a
 * terminator there would be text this tool simply could not send.
 */
export function parseArgs(argv: string[], spec: FlagSpec = {}): ParsedArgs {
  const valueFlags = new Set(spec.value ?? []);
  const boolFlags = new Set([...(spec.boolean ?? []), ...GLOBAL_BOOLEAN]);

  const positionals: string[] = [];
  const flags = new Map<string, string | true>();

  for (let i = 0; i < argv.length; i++) {
    // `noUncheckedIndexedAccess` is on: index reads are `string | undefined`,
    // and the loop bound is the only thing that says otherwise.
    const arg = argv[i] as string;
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('-') || arg === '-') {
      positionals.push(arg);
      continue;
    }
    if (valueFlags.has(arg)) {
      const value = argv[i + 1];
      // An absent value used to fall back to the flag's DEFAULT via `??`,
      // so `--seconds` with nothing after it silently meant 30.
      if (value === undefined) {
        throw new CliError(EXIT.USAGE, `${arg} needs a value`);
      }
      flags.set(arg, value);
      i++;
      continue;
    }
    if (boolFlags.has(arg)) {
      flags.set(arg, true);
      continue;
    }
    throw new CliError(EXIT.USAGE, `unknown option ${describeRejected(arg)}`);
  }

  return { positionals, flags };
}

/**
 * Every flag in this CLI that consumes the NEXT argv entry as its value.
 *
 * A union across all commands rather than a per-command set, because the
 * global scan below runs before the command's own spec is chosen. Being
 * over-inclusive here is harmless — the worst case is that a positional which
 * happens to equal `--title` hides a following `--json` from the *global*
 * scan, and the real per-command parse still sees it.
 */
const ALL_VALUE_FLAGS = new Set(['--title', '--seconds', '--ice', '--peer', '--limit']);

/**
 * Read the global flags out of raw argv, BEFORE the command's own spec exists.
 *
 * This has to exist (`--json` and `--help` must work even on a command whose
 * spec would reject something else on the line), and the obvious version of it
 * was wrong in two ways that both showed up as a working command line being
 * refused:
 *
 *  - it matched by PREFIX on the whole of argv, so
 *    `tacendum send ci me -- "--json is broken in prod"` fed the message body
 *    to the parser and died with `unknown option --json is broken in prod`.
 *    `--` exists precisely so a body may start with a dash; ignoring it here
 *    made the terminator a lie.
 *  - it did not know that `--title` takes a value, so
 *    `send ci me hello --title --json` — where `--json` is legitimately the
 *    title — silently switched the whole command into JSON mode.
 *
 * So: stop at `--`, match exactly, and skip the argument a value flag owns.
 * One scan, used by both the Reporter and the top-level error handler, so
 * there is exactly one rule for "was --json asked for".
 */
export function scanGlobals(argv: string[]): { json: boolean; plain: boolean } {
  let json = false;
  let plain = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '--') break;
    if (ALL_VALUE_FLAGS.has(arg)) {
      i++;
      continue;
    }
    if (arg === '--json') json = true;
    else if (arg === '--plain') plain = true;
  }
  return { json, plain };
}

export function flagString(args: ParsedArgs, flag: string): string | undefined {
  const value = args.flags.get(flag);
  return typeof value === 'string' ? value : undefined;
}

export function flagBool(args: ParsedArgs, flag: string): boolean {
  return args.flags.get(flag) === true;
}

/** A numeric flag, validated. NaN never reaches a timer again. */
export function flagNumber(args: ParsedArgs, flag: string, fallback: number): number {
  const raw = flagString(args, flag);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    // The flag NAME is safe (it is one of ours); the VALUE is not. `--seconds
    // "$SECRET"` from a misconfigured variable put the secret into stderr and
    // --json, i.e. hook and CI logs. Reachable through --seconds,
    // --limit and --ice; caught by harness.canary.test.ts once it began
    // generating flag-VALUE positions as well as positionals.
    throw new CliError(EXIT.USAGE, `${flag} expects a non-negative whole number`);
  }
  return parsed;
}

/**
 * A non-negative integer flag, for the ones that are counts or durations.
 * Separate from `flagNumber` because `--seconds -1` and `--ice 2.5` are both
 * accepted arithmetic and neither is a thing anyone meant.
 */
export function flagCount(args: ParsedArgs, flag: string, fallback: number): number {
  const value = flagNumber(args, flag, fallback);
  if (!Number.isInteger(value) || value < 0) {
    // `got ${value}` was the other half of the leak, and the half the canary
    // harness could not see: every secret it generates parses as NaN and is
    // caught upstream in `flagNumber`, but a NUMERIC secret is finite, sails
    // through there, and lands here — `--seconds 314159.2653` printed the
    // exact value into stderr and --json, i.e. hook and CI logs.
    // Redacting one path and not the other is how this class keeps coming
    // back: the rule is the flag NAME may be echoed and the VALUE may not,
    // and it has to hold at every site that formats one.
    throw new CliError(EXIT.USAGE, `${flag} expects a non-negative whole number`);
  }
  return value;
}
