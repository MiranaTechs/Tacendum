import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { tacendumHome } from './config.js';
import { CliError, EXIT } from './exit.js';
import { withFileLock } from './lock.js';
import {
  builtEntryPath,
  readConfigForEdit,
  splitTomlOrRefuse,
  structuralTomlLines,
} from './mcp-install.js';
import { parseAssignmentKeyLine } from './toml-keys.js';
import { writeFileAtomic } from './stores.js';
import {
  codexNotifyDispatchArgv,
  planFromCodexNotifyDispatchArgv,
  type CodexNotifyPlanV1,
  type CodexPreviousNotifier,
} from './codex-notify-dispatch.js';

/**
 * Host hook configuration for `tacendum setup <surface>`: the file each assistant host reads to learn that finishing a
 * task should run `tacendum notify`.
 *
 * SAME DISCIPLINE AS `mcp-install.ts` `--write`, because these are the same
 * kind of file: config OTHER tools own. `~/.claude/settings.json` holds the
 * operator's every other hook; `~/.codex/config.toml` holds their model and
 * approval settings. So, exactly as there: the merge touches only entries
 * that are provably ours, REFUSES a file it cannot parse instead of guessing,
 * backs the file up before the first byte changes, and a re-run that changes
 * nothing writes nothing — which is what makes `setup` safe to run twice.
 * `mergeJsonConfig`/`mergeTomlConfig` in mcp-install.ts are not called
 * directly because both are bound to the one `mcpServers.tacendum` /
 * `[mcp_servers.tacendum]` key; the hook keys live elsewhere in the same
 * files. The discipline is shared, the key-specific merges cannot be.
 *
 * WHAT MAKES AN ENTRY OURS is decided in exactly one place —
 * `isOurNotifyCommand` — because four surfaces re-deciding it is how a
 * re-run double-registers on one host and clobbers a stranger's hook on
 * another. Every merge below filters with that predicate and then appends
 * one fresh entry, so running setup twice, or after a path change, updates
 * in place instead of accumulating.
 */

export type SetupSurface = 'claude-code' | 'codex' | 'cursor' | 'gemini';
export const SETUP_SURFACES = ['claude-code', 'codex', 'cursor', 'gemini'] as const;

export function isSetupSurface(value: string): value is SetupSurface {
  return (SETUP_SURFACES as readonly string[]).includes(value);
}

/** The `--hook` tag each surface's payload adapter answers to (one
 * command: `tacendum notify --hook {claude|codex|gemini|cursor}`). */
const HOOK_TAG: Record<SetupSurface, string> = {
  'claude-code': 'claude',
  codex: 'codex',
  cursor: 'cursor',
  gemini: 'gemini',
};

/**
 * The matcher for Claude Code's `Notification` hook — the three events that
 * mean "the agent stopped and is waiting for a human".
 */
export const CLAUDE_NOTIFICATION_MATCHER = 'permission_prompt|idle_prompt|agent_needs_input';

/**
 * The notify invocation as argv. `process.execPath`, not "node", for the
 * reason mcp-install.ts records: hosts launched by launchd have a PATH that
 * has never seen nvm or Herd, so a bare "node" resolves to nothing and the
 * hook "fails" with no diagnostic surface.
 */
export function notifyArgv(surface: SetupSurface, account: string, entry: string): string[] {
  return [process.execPath, entry, 'notify', '--hook', HOOK_TAG[surface], '--account', account];
}

/**
 * Quote one word for /bin/sh, only when it needs it. The interpreter path
 * regularly contains a space on this product's main platform
 * (`~/Library/Application Support/...`), and an unquoted one splits into two
 * words and runs `/Users/x/Library/Application` — a failure with no
 * diagnostic surface inside a hook. Words that pass the safe set are left
 * bare so the marker below (` notify --hook `) survives in the command text.
 */
function shellWord(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

function notifyCommand(surface: SetupSurface, account: string, entry: string): string {
  return notifyArgv(surface, account, entry).map(shellWord).join(' ');
}

/** Claude's command-hook schema accepts one shell command string.  Keep the
 * semantic command as argv until this final formatting boundary so paths
 * with spaces and quotes cannot change argument boundaries. */
export function claudePermissionArgv(
  account: string,
  minimumAppBuild: number,
  entry: string,
): string[] {
  return [
    process.execPath,
    entry,
    'claude-permission',
    '--account',
    account,
    '--approvals',
    String(minimumAppBuild),
  ];
}

function claudePermissionCommand(account: string, minimumAppBuild: number, entry: string): string {
  return claudePermissionArgv(account, minimumAppBuild, entry).map(shellWord).join(' ');
}

/**
 * Split one /bin/sh command line back into the words `shellWord` produced:
 * bare words from the safe set, single-quoted words, and the `'\''` escape a
 * quote inside a quoted word becomes. Anything this module never writes —
 * double quotes, other backslash escapes, an unterminated quote — answers
 * null: a command that cannot be read back word-for-word is not PROVABLY
 * ours, and only provably-ours entries may ever be touched.
 */
function splitShellWords(command: string): string[] | null {
  const words: string[] = [];
  let current = '';
  let started = false;
  for (let i = 0; i < command.length; ) {
    const ch = command[i] as string;
    if (ch === ' ' || ch === '\t') {
      if (started) {
        words.push(current);
        current = '';
        started = false;
      }
      i += 1;
      continue;
    }
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) return null;
      current += command.slice(i + 1, end);
      started = true;
      i = end + 1;
      continue;
    }
    if (ch === '\\') {
      // The only escape `shellWord` emits: a literal quote between two
      // quoted runs (`'\''`).
      if (command[i + 1] !== "'") return null;
      current += "'";
      started = true;
      i += 2;
      continue;
    }
    if (ch === '"') return null;
    current += ch;
    started = true;
    i += 1;
  }
  if (started) words.push(current);
  return words;
}

const OUR_HOOK_TAGS: ReadonlySet<string> = new Set(Object.values(HOOK_TAG));

/**
 * Is this hook command string one of ours? THE one rule every merge filters
 * by — and it identifies our ENTRY, not a substring: it used to be
 * `includes('notify --hook')`, which silently removed an unrelated command
 * like `/usr/local/bin/acme notify --hook slack` as "ours" (F6). Now the
 * command is split back into the argv this module writes and must read
 * `<program…> notify --hook <one of OUR four tags> --account <name>`, with
 * `notify` as the first subcommand word (at most two program words precede
 * it: interpreter + entry, or a bare `tacendum`). An operator's hand-written
 * `tacendum notify --hook claude --account ci` still matches, which is the
 * right outcome: setup adopts and updates it rather than adding a second one.
 */
function isOurNotifyCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false;
  const words = splitShellWords(command);
  if (words === null) return false;
  const at = words.indexOf('notify');
  return (
    at > 0 &&
    at <= 2 &&
    words[at + 1] === '--hook' &&
    OUR_HOOK_TAGS.has(words[at + 2] ?? '') &&
    words[at + 3] === '--account' &&
    typeof words[at + 4] === 'string'
  );
}

interface ParsedClaudePermissionCommand {
  nodePath: string;
  entryPath: string;
  account: string;
  minimumAppBuild: number;
}

/** The exact private subcommand shape, independent of ownership. Ownership
 * additionally requires the executable and entry path this setup intends. */
function parseClaudePermissionCommand(command: unknown): ParsedClaudePermissionCommand | null {
  if (typeof command !== 'string') return null;
  const words = splitShellWords(command);
  if (
    words === null ||
    words.length !== 7 ||
    words[2] !== 'claude-permission' ||
    words[3] !== '--account' ||
    words[4] === undefined ||
    words[5] !== '--approvals' ||
    !/^\d+$/.test(words[6] ?? '')
  ) {
    return null;
  }
  const minimumAppBuild = Number(words[6]);
  if (!Number.isSafeInteger(minimumAppBuild) || minimumAppBuild < 1) return null;
  return {
    nodePath: words[0] as string,
    entryPath: words[1] as string,
    account: words[4],
    minimumAppBuild,
  };
}

function isOwnedClaudePermissionCommand(
  command: unknown,
  nodePath: string,
  entryPath: string,
): boolean {
  const parsed = parseClaudePermissionCommand(command);
  return parsed?.nodePath === nodePath && parsed.entryPath === entryPath;
}

function directCodexAccount(argv: readonly string[]): string | null {
  const at = argv.indexOf('notify');
  if (
    at < 1 ||
    at > 2 ||
    argv.length !== at + 5 ||
    argv[at + 1] !== '--hook' ||
    argv[at + 2] !== 'codex' ||
    argv[at + 3] !== '--account'
  ) {
    return null;
  }
  return argv[at + 4] ?? null;
}

/** Parse the one value Codex accepts here: an array of TOML strings.  This is
 * deliberately not a general TOML value parser; numbers, inline tables and
 * nested arrays cannot be argv and are refusals.  Comments and reflowed
 * arrays are supported because they are ordinary operator formatting. */
function parseCodexNotifyArgv(assignment: string): string[] | null {
  const equals = assignment.indexOf('=');
  if (equals === -1) return null;
  const value = assignment.slice(equals + 1);
  let i = 0;
  const skip = (): void => {
    for (;;) {
      while (/\s/.test(value[i] ?? '')) i += 1;
      if (value[i] !== '#') return;
      const newline = value.indexOf('\n', i);
      i = newline === -1 ? value.length : newline + 1;
    }
  };
  const basicEscapes: Record<string, string> = {
    b: '\b',
    t: '\t',
    n: '\n',
    f: '\f',
    r: '\r',
    '"': '"',
    '\\': '\\',
  };
  const oneString = (): string | null => {
    const quote = value[i];
    if (quote !== '"' && quote !== "'") return null;
    // A multiline string is valid TOML but not needed for executable argv;
    // refusing it is safer than implementing a second general TOML parser.
    if (value[i + 1] === quote && value[i + 2] === quote) return null;
    i += 1;
    let out = '';
    while (i < value.length) {
      const ch = value[i] as string;
      if (ch === quote) {
        i += 1;
        return out;
      }
      if (ch === '\n' || ch === '\r' || ch === '\0' || (ch < ' ' && ch !== '\t')) return null;
      if (quote === '"' && ch === '\\') {
        const esc = value[i + 1];
        if (esc !== undefined && esc in basicEscapes) {
          out += basicEscapes[esc] as string;
          i += 2;
          continue;
        }
        if (esc === 'u' || esc === 'U') {
          const count = esc === 'u' ? 4 : 8;
          const hex = value.slice(i + 2, i + 2 + count);
          if (!new RegExp(`^[0-9A-Fa-f]{${count}}$`).test(hex)) return null;
          const codePoint = Number.parseInt(hex, 16);
          if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return null;
          out += String.fromCodePoint(codePoint);
          i += 2 + count;
          continue;
        }
        return null;
      }
      out += ch;
      i += 1;
    }
    return null;
  };

  skip();
  if (value[i] !== '[') return null;
  i += 1;
  const argv: string[] = [];
  for (;;) {
    skip();
    if (value[i] === ']') {
      i += 1;
      break;
    }
    const item = oneString();
    if (item === null) return null;
    argv.push(item);
    skip();
    if (value[i] === ',') {
      i += 1;
      continue;
    }
    if (value[i] === ']') {
      i += 1;
      break;
    }
    return null;
  }
  skip();
  return i === value.length ? argv : null;
}

type PythonLiteral = string | PythonLiteral[] | { [key: string]: PythonLiteral };

/** Parse the deliberately tiny Python-literal subset used by the one
 * pre-product dispatcher.  This never executes or imports that file.  The
 * caller first verifies its exact recorded digest, so this parser is only a
 * structured way to recover the static COMMANDS value from known bytes. */
function parsePythonLiteral(text: string): PythonLiteral | null {
  let i = 0;
  const ws = (): void => {
    while (/\s/.test(text[i] ?? '')) i += 1;
  };
  const string = (): string | null => {
    const quote = text[i];
    if (quote !== "'" && quote !== '"') return null;
    if (text[i + 1] === quote && text[i + 2] === quote) return null;
    i += 1;
    let out = '';
    const escapes: Record<string, string> = {
      a: '\x07',
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
      v: '\v',
      '\\': '\\',
      "'": "'",
      '"': '"',
    };
    while (i < text.length) {
      const ch = text[i] as string;
      if (ch === quote) {
        i += 1;
        return out;
      }
      if (ch === '\n' || ch === '\r' || ch === '\0') return null;
      if (ch !== '\\') {
        out += ch;
        i += 1;
        continue;
      }
      const esc = text[i + 1];
      if (esc !== undefined && esc in escapes) {
        out += escapes[esc] as string;
        i += 2;
        continue;
      }
      const widths: Record<string, number> = { x: 2, u: 4, U: 8 };
      const width = esc === undefined ? undefined : widths[esc];
      if (width === undefined) return null;
      const hex = text.slice(i + 2, i + 2 + width);
      if (!new RegExp(`^[0-9A-Fa-f]{${width}}$`).test(hex)) return null;
      const codePoint = Number.parseInt(hex, 16);
      if (codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
        return null;
      }
      out += String.fromCodePoint(codePoint);
      i += 2 + width;
    }
    return null;
  };
  const value = (): PythonLiteral | null => {
    ws();
    const ch = text[i];
    if (ch === "'" || ch === '"') return string();
    if (ch === '[' || ch === '(') {
      const close = ch === '[' ? ']' : ')';
      i += 1;
      const items: PythonLiteral[] = [];
      for (;;) {
        ws();
        if (text[i] === close) {
          i += 1;
          return items;
        }
        const item = value();
        if (item === null) return null;
        items.push(item);
        ws();
        if (text[i] === ',') {
          i += 1;
          continue;
        }
        if (text[i] !== close) return null;
        i += 1;
        return items;
      }
    }
    if (ch === '{') {
      i += 1;
      const object: { [key: string]: PythonLiteral } = Object.create(null) as {
        [key: string]: PythonLiteral;
      };
      for (;;) {
        ws();
        if (text[i] === '}') {
          i += 1;
          return object;
        }
        const key = string();
        if (key === null) return null;
        ws();
        if (text[i] !== ':') return null;
        i += 1;
        const item = value();
        if (item === null) return null;
        object[key] = item;
        ws();
        if (text[i] === ',') {
          i += 1;
          continue;
        }
        if (text[i] !== '}') return null;
        i += 1;
        return object;
      }
    }
    return null;
  };
  const parsed = value();
  ws();
  return parsed !== null && i === text.length ? parsed : null;
}

function literalArgv(value: PythonLiteral | undefined): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || !value.every(item => typeof item === 'string')) {
    return null;
  }
  return [...value] as string[];
}

function literalEnv(value: PythonLiteral | undefined): Record<string, string> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (!entries.every(([, item]) => typeof item === 'string')) return null;
  return Object.fromEntries(entries) as Record<string, string>;
}

interface LegacyCodexMigration {
  previous: CodexPreviousNotifier[];
  tacendumEnv: Record<string, string>;
}

const LEGACY_CODEX_DISPATCHER_SHA256 =
  'cc1f37e1c9ef051ae56696b1310bc8ae756ffae72c928c0ae651225a74399b9d';

function legacyCodexDispatcherArgv(): readonly [string, string] {
  return [
    '/Library/Frameworks/Python.framework/Versions/3.14/bin/python3',
    join(homedir(), '.codex', 'hooks', 'tacendum-notify.py'),
  ];
}

function migrateLegacyCodexDispatcher(
  argv: readonly string[],
  io: HostConfigIo,
): LegacyCodexMigration | null {
  const expected = io.legacyCodexDispatcherArgv ?? legacyCodexDispatcherArgv();
  // This exact path is the only ambiguous case: the known script already
  // sends through Tacendum, so treating changed bytes/argv as an unrelated
  // notifier could add a second delivery.  Refuse instead of guessing.
  if (argv[1] !== expected[1]) return null;
  if (argv.length !== expected.length || argv.some((item, index) => item !== expected[index])) {
    throw new CliError(
      EXIT.ERROR,
      'the legacy Codex dispatcher command has changed — refusing to add a second Tacendum delivery',
    );
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(expected[1]);
  } catch {
    throw new CliError(
      EXIT.ERROR,
      'the legacy Codex dispatcher cannot be read — refusing to add a second Tacendum delivery',
    );
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== (io.legacyCodexDispatcherSha256 ?? LEGACY_CODEX_DISPATCHER_SHA256)) {
    throw new CliError(
      EXIT.ERROR,
      'the legacy Codex dispatcher file has changed — refusing to add a second Tacendum delivery',
    );
  }
  const commandLines = bytes
    .toString('utf8')
    .split('\n')
    .filter(line => line.startsWith('COMMANDS = '));
  if (commandLines.length !== 1) {
    throw new CliError(EXIT.ERROR, 'the validated legacy Codex dispatcher has an unreadable command plan');
  }
  const literal = parsePythonLiteral((commandLines[0] as string).slice('COMMANDS = '.length));
  if (!Array.isArray(literal) || literal.length !== 2) {
    throw new CliError(EXIT.ERROR, 'the validated legacy Codex dispatcher has an unreadable command plan');
  }
  const previousPair = literal[0];
  const tacendumPair = literal[1];
  if (!Array.isArray(previousPair) || previousPair.length !== 2 || !Array.isArray(tacendumPair) || tacendumPair.length !== 2) {
    throw new CliError(EXIT.ERROR, 'the validated legacy Codex dispatcher has an unreadable command plan');
  }
  const previousArgv = literalArgv(previousPair[0]);
  const previousEnv = literalEnv(previousPair[1]);
  const oldTacendumArgv = literalArgv(tacendumPair[0]);
  const tacendumEnv = literalEnv(tacendumPair[1]);
  if (
    previousArgv === null ||
    previousEnv === null ||
    oldTacendumArgv === null ||
    directCodexAccount(oldTacendumArgv) === null ||
    tacendumEnv === null
  ) {
    throw new CliError(EXIT.ERROR, 'the validated legacy Codex dispatcher has an unreadable command plan');
  }
  return { previous: [{ argv: previousArgv, env: previousEnv }], tacendumEnv };
}

function managedCodexLine(
  directArgv: string[],
  previous: CodexPreviousNotifier[],
  tacendumEnv?: Record<string, string>,
): string {
  const account = directCodexAccount(directArgv);
  if (account === null || directArgv[0] === undefined || directArgv[1] === undefined) {
    throw new CliError(EXIT.ERROR, 'internal: invalid tacendum Codex notifier argv');
  }
  const plan: CodexNotifyPlanV1 = {
    v: 1,
    account,
    previous,
    ...(tacendumEnv !== undefined ? { tacendumEnv } : {}),
  };
  return codexNotifyLine(codexNotifyDispatchArgv(directArgv[0], directArgv[1], plan));
}

export function hostConfigPathFor(surface: SetupSurface): string {
  switch (surface) {
    // User scope for all four, unlike mcp-install's project-scoped
    // `.mcp.json`: a notification hook is about the OPERATOR's phone, not
    // about one repository, and the notify adapter tags each message with
    // the project from cwd at fire time — so one
    // user-level registration covers every project without a per-repo file.
    case 'claude-code':
      return join(homedir(), '.claude', 'settings.json');
    case 'codex':
      return join(homedir(), '.codex', 'config.toml');
    case 'cursor':
      return join(homedir(), '.cursor', 'hooks.json');
    case 'gemini':
      return join(homedir(), '.gemini', 'settings.json');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The model the OPERATOR's own `~/.gemini/settings.json` pins (`model.name`),
 * or undefined (§3.8; `attend.ts:operatorCodexModel`'s sibling,
 * and its asymmetry argument holds verbatim).
 *
 * Read once, at `attend enable` time, so gemini's isolated `GEMINI_CLI_HOME`
 * cannot change the operator's model silently: `model.name` is a user-level
 * settings key, so an isolated home drops it and every reply would come from
 * gemini's built-in default at a different price and quality with nothing in
 * the reply saying so.
 *
 * JSON, NOT TOML, so none of the toml-keys machinery applies — one guarded
 * `JSON.parse` does, and it deliberately does NOT go through
 * `parseJsonConfig`: that function REFUSES an unparseable file because it is
 * about to rewrite it, and refusing is the right posture for a merge and the
 * wrong one for a read. EVERY failure here reads as UNPINNED — no file, bad
 * JSON, not an object, no `model.name`, a name this cannot state as an argv
 * word. The two failure shapes are not symmetric: unpinned falls back to
 * gemini's own supported default, while a mis-decoded name would ask gemini
 * for a model that does not exist and fail EVERY turn until someone
 * re-enables.
 *
 * Printable ASCII, bounded, because the value lands in an argv element
 * (`-m <name>`) — the same guard that keeps a NUL or a control byte out of
 * execve. The PATH comes from `hostConfigPathFor('gemini')`, so the file this
 * reads is the one file this module already names for that surface.
 *
 * Measured on this machine 2026-09-04: `~/.gemini/settings.json` exists and
 * pins NO `model.name` (it declares only `mcpServers.aws-mcp`), so the
 * unpinned path is the live path here.
 */
export function operatorGeminiModel(io: { readFile?: (p: string) => string } = {}): string | undefined {
  let raw: string;
  try {
    raw = (io.readFile ?? ((p: string) => readFileSync(p, 'utf8')))(hostConfigPathFor('gemini'));
  } catch {
    return undefined; // no settings file: gemini's default IS current behaviour
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined; // a hand edit mid-thought is not a model pin to guess at
  }
  if (!isRecord(parsed)) return undefined;
  const model = parsed['model'];
  if (!isRecord(model)) return undefined;
  const name = model['name'];
  if (typeof name !== 'string') return undefined;
  // NOT FLAG-SHAPED, at CAPTURE time — the same rule `geminiModelPin` applies
  // at emit time, so the two cannot disagree. Without this a hand-edited
  // `model.name` of `--yolo` is captured and persisted, the driver drops it,
  // and the enable read-back reports `geminiModelPinned: true` for a pin no
  // turn will ever use.
  if (name.startsWith('-')) return undefined;
  return /^[\x21-\x7e]{1,64}$/.test(name) ? name : undefined;
}

/** Parse an existing JSON config, with mcp-install's exact refusal posture:
 * a file that does not parse is a hand edit mid-thought, and "my other hooks
 * vanished" is the failure this refusal makes impossible. */
function parseJsonConfig(existing: string | null): Record<string, unknown> {
  if (existing === null || existing.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch {
    throw new CliError(
      EXIT.ERROR,
      'the existing config is not valid JSON — refusing to guess at a merge; fix or move it first',
    );
  }
  if (!isRecord(parsed)) {
    throw new CliError(EXIT.ERROR, 'the existing config is not a JSON object — refusing to overwrite it');
  }
  return parsed;
}

/**
 * Replace our entries in a hook list and append `entry`, leaving everything
 * that is not ours byte-for-byte alone. Works for both list shapes in play:
 * Claude/Gemini groups (`{matcher?, hooks: [{command}]}`) and Cursor's flat
 * `[{command}]` — in both, "ours" is decided by the command string alone.
 *
 * A list that exists but is not an array is a REFUSAL, not an overwrite:
 * whatever put it there, replacing it destroys data this tool cannot read.
 */
type HookCommandOwner = (command: unknown) => boolean;

function withOurEntry(
  list: unknown,
  key: string,
  entry: Record<string, unknown>,
  owns: HookCommandOwner = isOurNotifyCommand,
): unknown[] {
  if (list !== undefined && !Array.isArray(list)) {
    throw new CliError(
      EXIT.ERROR,
      `the existing config's ${key} is not a list — refusing to overwrite it`,
    );
  }
  const kept = withoutOurEntries((list as unknown[] | undefined) ?? [], owns);
  kept.push(entry);
  return kept;
}

/** The filter half of `withOurEntry`, alone — for a list we used to write
 * into and no longer do (gemini's `Stop`), where ours must go and nothing
 * may be appended. */
function withoutOurEntries(
  list: unknown[],
  owns: HookCommandOwner = isOurNotifyCommand,
): unknown[] {
  const kept: unknown[] = [];
  for (const item of list) {
    if (!isRecord(item)) {
      kept.push(item);
      continue;
    }
    // Flat shape: the command sits on the item itself.
    if (owns(item.command)) continue;
    // Group shape: the commands sit one level down. Filter only ours out of
    // the group; a group that held ONLY ours disappears with them.
    if (Array.isArray(item.hooks)) {
      const hooks = item.hooks.filter(h => !(isRecord(h) && owns(h.command)));
      if (hooks.length === 0 && item.hooks.length > 0) continue;
      kept.push(hooks.length === item.hooks.length ? item : { ...item, hooks });
      continue;
    }
    kept.push(item);
  }
  return kept;
}

function hookCommandValues(list: unknown): unknown[] {
  if (!Array.isArray(list)) return [];
  const commands: unknown[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    if (item.command !== undefined) commands.push(item.command);
    if (Array.isArray(item.hooks)) {
      for (const hook of item.hooks) {
        if (isRecord(hook) && hook.command !== undefined) commands.push(hook.command);
      }
    }
  }
  return commands;
}

function claudePermissionOwner(command: string): { nodePath: string; entryPath: string } {
  const parsed = parseClaudePermissionCommand(command);
  if (parsed === null) {
    throw new CliError(EXIT.ERROR, 'internal: invalid Claude permission hook command');
  }
  return { nodePath: parsed.nodePath, entryPath: parsed.entryPath };
}

function refuseUnownedClaudePermissionClaims(
  list: unknown,
  owner: { nodePath: string; entryPath: string },
): void {
  for (const command of hookCommandValues(list)) {
    const parsed = parseClaudePermissionCommand(command);
    if (
      parsed !== null &&
      (parsed.nodePath !== owner.nodePath || parsed.entryPath !== owner.entryPath)
    ) {
      throw new CliError(
        EXIT.ERROR,
        'the existing PermissionRequest list claims Tacendum\'s private approval command, but its executable ownership cannot be established — refusing to replace or compose it',
      );
    }
  }
}

/** One Claude-style hook command. `async: true` is row 6's requirement: the
 * hook must never hold the agent; the notify adapter's own internal timeout
 * (not this file's business) is the second layer of the same rule. */
function claudeHookGroup(command: string, matcher?: string): Record<string, unknown> {
  return {
    ...(matcher !== undefined ? { matcher } : {}),
    hooks: [{ type: 'command', command, async: true, timeout: 10 }],
  };
}

function claudePermissionHookGroup(command: string): Record<string, unknown> {
  return { hooks: [{ type: 'command', command, timeout: 600 }] };
}

function hasOnlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record);
  return actual.length === keys.length && actual.every(key => keys.includes(key));
}

/** Match the complete hook objects this release writes. Capability reporting
 * cannot treat a familiar command string as proof: `async` and timeout are
 * execution semantics, and a command nested under a malformed group never
 * runs at all. Foreign groups may coexist, but the maintained group itself
 * must retain its exact shape. */
function hasExactGroupedHook(
  list: unknown,
  command: string,
  kind:
    | { host: 'claude'; matcher?: string }
    | { host: 'gemini' },
): boolean {
  if (!Array.isArray(list)) return false;
  if (hookCommandValues(list).filter(candidate => candidate === command).length !== 1) return false;
  return list.some(item => {
    if (!isRecord(item) || !Array.isArray(item.hooks) || item.hooks.length !== 1) return false;
    const hook = item.hooks[0];
    if (!isRecord(hook) || hook.type !== 'command' || hook.command !== command) return false;
    if (kind.host === 'claude') {
      const groupKeys = kind.matcher === undefined ? ['hooks'] : ['matcher', 'hooks'];
      return (
        hasOnlyKeys(item, groupKeys) &&
        item.matcher === kind.matcher &&
        hasOnlyKeys(hook, ['type', 'command', 'async', 'timeout']) &&
        hook.async === true &&
        hook.timeout === 10
      );
    }
    return (
      hasOnlyKeys(item, ['hooks']) &&
      hasOnlyKeys(hook, ['type', 'command', 'timeout']) &&
      hook.timeout === 10_000
    );
  });
}

function hasExactCursorHook(list: unknown, command: string): boolean {
  if (!Array.isArray(list)) return false;
  if (hookCommandValues(list).filter(candidate => candidate === command).length !== 1) return false;
  return list.some(
    item => isRecord(item) && hasOnlyKeys(item, ['command']) && item.command === command,
  );
}

function hasExactClaudePermission(
  list: unknown,
  account: string,
  entryPath: string,
): boolean {
  if (!Array.isArray(list)) return false;
  const owned = hookCommandValues(list).filter(command => {
    const parsed = parseClaudePermissionCommand(command);
    return (
      parsed?.nodePath === process.execPath &&
      parsed.entryPath === entryPath &&
      parsed.account === account
    );
  });
  if (owned.length !== 1) return false;
  return list.some(item => {
    if (
      !isRecord(item) ||
      !hasOnlyKeys(item, ['hooks']) ||
      !Array.isArray(item.hooks) ||
      item.hooks.length !== 1
    ) {
      return false;
    }
    const hook = item.hooks[0];
    if (
      !isRecord(hook) ||
      !hasOnlyKeys(hook, ['type', 'command', 'timeout']) ||
      hook.type !== 'command' ||
      hook.timeout !== 600
    ) {
      return false;
    }
    const parsed = parseClaudePermissionCommand(hook.command);
    return (
      parsed?.nodePath === process.execPath &&
      parsed.entryPath === entryPath &&
      parsed.account === account
    );
  });
}

/** The root's `hooks` table, or a refusal — never an overwrite of a shape
 * some other tool understood and this one does not. One function, because
 * three merges re-deciding it is the divergence this repo keeps re-finding. */
function hooksTable(root: Record<string, unknown>): Record<string, unknown> {
  if (root.hooks !== undefined && !isRecord(root.hooks)) {
    throw new CliError(
      EXIT.ERROR,
      "the existing config's hooks is not an object — refusing to overwrite it",
    );
  }
  return isRecord(root.hooks) ? { ...root.hooks } : {};
}

/**
 * Claude Code (`~/.claude/settings.json`): `Stop` fires
 * on a finished turn, `Notification` (matched to the three needs-a-human
 * events) fires when the agent is blocked waiting.
 */
export function mergeClaudeSettings(
  existing: string | null,
  command: string,
  permissionCommand?: string,
): string {
  const root = parseJsonConfig(existing);
  const hooks = hooksTable(root);
  hooks.Stop = withOurEntry(hooks.Stop, 'hooks.Stop', claudeHookGroup(command));
  hooks.Notification = withOurEntry(
    hooks.Notification,
    'hooks.Notification',
    claudeHookGroup(command, CLAUDE_NOTIFICATION_MATCHER),
  );
  if (permissionCommand !== undefined) {
    const owner = claudePermissionOwner(permissionCommand);
    refuseUnownedClaudePermissionClaims(hooks.PermissionRequest, owner);
    hooks.PermissionRequest = withOurEntry(
      hooks.PermissionRequest,
      'hooks.PermissionRequest',
      claudePermissionHookGroup(permissionCommand),
      candidate => isOwnedClaudePermissionCommand(candidate, owner.nodePath, owner.entryPath),
    );
  }
  root.hooks = hooks;
  return `${JSON.stringify(root, null, 2)}\n`;
}

function hasConfiguredClaudePermission(
  rendered: string,
  account: string,
  entryPath: string,
): boolean {
  const root = JSON.parse(rendered) as Record<string, unknown>;
  if (!isRecord(root.hooks)) return false;
  return hasExactClaudePermission(root.hooks.PermissionRequest, account, entryPath);
}

/** One Gemini-style hook entry. Gemini's hook schema
 * (google-gemini/gemini-cli docs/hooks/reference.md, verified 2026-07-30)
 * differs from Claude's twice over: there is no `async` field (hooks in a
 * group run in parallel unless `sequential: true`), and `timeout` is in
 * MILLISECONDS (default 60000) — Claude's `timeout: 10` would give the hook
 * 10ms, killing it before node finishes loading. */
function geminiHookGroup(command: string): Record<string, unknown> {
  return { hooks: [{ type: 'command', command, timeout: 10_000 }] };
}

/**
 * Gemini CLI (`~/.gemini/settings.json`): a `hooks` table like Claude's, but
 * with Gemini's OWN event vocabulary and entry shape. `AfterAgent` is its
 * finished-turn event, and it is the event `parseGeminiHook` (hooks.ts)
 * answers to — the `prompt_response` stdin field carries the final text.
 *
 * Earlier builds wrote a Claude-shaped entry under `hooks.Stop` here; Gemini
 * has no `Stop` event, so that hook could never fire. A re-run removes the
 * dead entry (only ours — a stranger's `Stop` list, whatever put it there,
 * survives untouched).
 */
export function mergeGeminiSettings(existing: string | null, command: string): string {
  const root = parseJsonConfig(existing);
  const hooks = hooksTable(root);
  hooks.AfterAgent = withOurEntry(hooks.AfterAgent, 'hooks.AfterAgent', geminiHookGroup(command));
  if (Array.isArray(hooks.Stop)) {
    const kept = withoutOurEntries(hooks.Stop);
    if (kept.length === 0 && hooks.Stop.length > 0) delete hooks.Stop;
    else hooks.Stop = kept;
  }
  root.hooks = hooks;
  return `${JSON.stringify(root, null, 2)}\n`;
}

/**
 * Cursor (`~/.cursor/hooks.json`): the two-hook dance.
 * `stop` alone lacks the message text, so `afterAgentResponse` runs the same
 * command to cache it and `stop` runs it again to send — WHICH event fired
 * is in the JSON the host pipes on stdin, so both entries are one command
 * and the adapter (another module's job) tells them apart.
 */
export function mergeCursorHooks(existing: string | null, command: string): string {
  const root = parseJsonConfig(existing);
  // Cursor requires the version field; an existing value is the operator's.
  if (root.version === undefined) root.version = 1;
  const hooks = hooksTable(root);
  hooks.afterAgentResponse = withOurEntry(hooks.afterAgentResponse, 'hooks.afterAgentResponse', { command });
  hooks.stop = withOurEntry(hooks.stop, 'hooks.stop', { command });
  root.hooks = hooks;
  return `${JSON.stringify(root, null, 2)}\n`;
}

/** A TOML basic string (same escaping mcp-install.ts uses; not exported
 * there, and three lines is below the threshold at which sharing beats a
 * cross-module reach into another command's internals). */
function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function codexNotifyLine(argv: string[]): string {
  return `notify = [${argv.map(tomlString).join(', ')}] # tacendum: E2EE notify-on-finish (tacendum setup codex)`;
}

/**
 * Codex (`~/.codex/config.toml`): one top-level line,
 * `notify = [argv...]`.
 *
 * TOP-LEVEL is the constraint that shapes this merge and is why it cannot be
 * mcp-install's `mergeTomlConfig`: that helper appends its section at the
 * END of the file, which is correct for a `[table]` and wrong for a bare
 * key — a `notify = …` after any table header silently becomes a key OF
 * that table and Codex never sees it. So ours is inserted BEFORE the first
 * table header, and only the top-level region is scanned for an existing one.
 *
 * A readable foreign `notify` is retained as a child of Tacendum's bounded
 * dispatcher because Codex has exactly one notify slot. Its argv boundaries
 * are preserved and Codex's JSON payload is appended once at runtime. Values
 * that cannot be parsed as string argv, duplicate keys, and commands that
 * imitate Tacendum's private formats without current executable ownership
 * are refused rather than guessed at or echoed.
 */
export function mergeCodexNotify(
  existing: string | null,
  argv: string[],
  io: HostConfigIo = {},
): string {
  let ourLine = managedCodexLine(argv, []);
  const raw = existing ?? '';
  if (raw.trim() === '') return `${ourLine}\n`;

  // Same lexical discipline as mergeTomlConfig, for the same reasons: \r\n
  // is normalized away (and restored on output — never a whole-file ending
  // rewrite, never mixed endings), and every structural judgement consults
  // the line map first. A `[table]`-looking line inside a """docstring""" is
  // seven characters of string content — inserting our notify line "before"
  // it used to plant the line INSIDE the string, where codex reads it as
  // prose and the merge still reported success; a `notify = …` inside one
  // used to read as a foreign notifier and refuse a perfectly valid file.
  const { lines, eol } = splitTomlOrRefuse(raw);
  const text = lines.join('\n');
  const structural = structuralTomlLines(lines);
  const restore = (merged: string): string =>
    assertOneTopLevelNotify(eol === '\n' ? merged : merged.replace(/\n/g, eol));
  const firstTable = lines.findIndex((l, i) => (structural[i] ?? false) && /^\s*\[/.test(l));
  const topLevel = firstTable === -1 ? lines.length : firstTable;

  // Key identity by PARSED path, never by line text: `"notify" = …` and
  // `'notify' = …` are the same top-level key as `notify = …`, and a dotted
  // `notify.x = …` makes notify a TABLE our line may not redefine. The old
  // text match recognised only the bare spelling, so a quoted one got a
  // SECOND top-level `notify` inserted — invalid TOML — and, worse, a
  // quoted FOREIGN notifier sailed past the refusal below.
  const notifyAts: number[] = [];
  for (let i = 0; i < topLevel; i += 1) {
    if (!structural[i]) continue; // value content — never a key
    const path = parseAssignmentKeyLine(lines[i] ?? '');
    if (path === null || path[0] !== 'notify') continue;
    if (path.length > 1) {
      throw new CliError(
        EXIT.ERROR,
        'config.toml defines top-level `notify` as a table (a dotted notify.* key) — ' +
          `refusing to add a notify line that would redefine it. To switch to tacendum, replace that key yourself with:\n${ourLine}`,
      );
    }
    notifyAts.push(i);
  }

  if (notifyAts.length > 0) {
    const extentEnd = (at: number): number => {
      let e = at + 1;
      while (e < lines.length && !structural[e]) e += 1;
      return e;
    };
    if (notifyAts.length !== 1) {
      throw new CliError(
        EXIT.ERROR,
        'config.toml defines top-level `notify` more than once — refusing to guess which value Codex uses',
      );
    }
    const at = notifyAts[0] as number;
    const existingArgv = parseCodexNotifyArgv(lines.slice(at, extentEnd(at)).join('\n'));
    if (existingArgv === null) {
      throw new CliError(
        EXIT.ERROR,
        'config.toml has a top-level `notify` value this setup cannot safely read as argv — ' +
          'refusing to overwrite it',
      );
    }
    let managed: CodexNotifyPlanV1 | null;
    try {
      managed = planFromCodexNotifyDispatchArgv(existingArgv, {
        nodePath: argv[0] ?? '',
        entryPath: argv[1] ?? '',
      });
    } catch (err) {
      if (err instanceof Error && err.message.includes('ownership cannot be established')) {
        throw new CliError(
          EXIT.ERROR,
          'config.toml claims the managed Codex notifier command, but its executable ownership cannot be established — refusing to replace or compose it',
        );
      }
      throw new CliError(
        EXIT.ERROR,
        'config.toml contains a malformed managed Codex notifier — refusing to guess at its handlers',
      );
    }
    if (managed !== null) {
      ourLine = managedCodexLine(argv, managed.previous, managed.tacendumEnv);
    } else if (directCodexAccount(existingArgv) !== null) {
      if (existingArgv[0] !== argv[0] || existingArgv[1] !== argv[1]) {
        throw new CliError(
          EXIT.ERROR,
          'config.toml contains an ambiguous Codex notifier that resembles Tacendum but is not owned by the current executable — refusing to replace or compose it',
        );
      }
    } else {
      const legacy = migrateLegacyCodexDispatcher(existingArgv, io);
      ourLine =
        legacy === null
          ? managedCodexLine(argv, [{ argv: existingArgv }])
          : managedCodexLine(argv, legacy.previous, legacy.tacendumEnv);
    }
    // Replace the single notify assignment WITH ITS WHOLE EXTENT: a value
    // reflowed across lines continues until the next structural line, and
    // swapping only its first line leaves the old array tail as invalid TOML.
    const keep = notifyAts[0] as number;
    const out: string[] = [];
    let i = 0;
    while (i < lines.length) {
      if (notifyAts.includes(i)) {
        if (i === keep) out.push(ourLine);
        i = extentEnd(i);
        continue;
      }
      out.push(lines[i] ?? '');
      i += 1;
    }
    const merged = out.join('\n');
    return restore(merged.endsWith('\n') ? merged : `${merged}\n`);
  }

  if (firstTable === -1) {
    return restore(`${text.replace(/\n*$/, '')}\n${ourLine}\n`);
  }
  const merged = [...lines.slice(0, firstTable), ourLine, '', ...lines.slice(firstTable)].join('\n');
  return restore(merged.endsWith('\n') ? merged : `${merged}\n`);
}

/** The outcome guard, mergeTomlConfig-style: whatever the merge produced,
 * exactly one top-level `notify` may leave this module. It counts with the
 * same lexical eyes as the merge — \r\n normalized, only structural lines —
 * so a notify line that LANDED INSIDE a string (the exact corruption the
 * lexical scan prevents) counts as the zero it really is and fails loudly
 * instead of passing as one. Throwing here means a bug above — and a
 * CliError instead of a corrupted host config. */
function assertOneTopLevelNotify(merged: string): string {
  const lines = merged.replace(/\r\n/g, '\n').split('\n');
  const structural = structuralTomlLines(lines);
  const firstTable = lines.findIndex((l, i) => (structural[i] ?? false) && /^\s*\[/.test(l));
  const topLevel = firstTable === -1 ? lines.length : firstTable;
  let count = 0;
  for (let i = 0; i < topLevel; i += 1) {
    if (!structural[i]) continue;
    const path = parseAssignmentKeyLine(lines[i] ?? '');
    if (path !== null && path.length === 1 && path[0] === 'notify') count += 1;
  }
  if (count !== 1) {
    throw new CliError(
      EXIT.ERROR,
      `internal: the merged config sets top-level notify ${count} times — refusing to write it`,
    );
  }
  return merged;
}

/** Test seams, mcp-install-style: merges are worth testing against temp
 * files, and a unit test must never touch the real `~/Library`. */
export interface HostConfigIo {
  entryPath?: string;
  targetPath?: string;
  /** Test seam for the one exact pre-product dispatcher migration. */
  legacyCodexDispatcherArgv?: readonly [string, string];
  /** Test seam; production uses the digest recorded in the installation note. */
  legacyCodexDispatcherSha256?: string;
}

/** Behavioral setup options are separate from HostConfigIo's filesystem
 * seams.  Native Claude approvals are opt-in because PermissionRequest is a
 * synchronous policy boundary; ordinary notification setup must not install
 * or remove it implicitly. */
export interface HostConfigOptions {
  claudePermission?: {
    minimumAppBuild: number;
  };
}

export interface HostConfigOutcome {
  path: string;
  /** False when the file already said exactly this — the idempotent re-run. */
  changed: boolean;
  backup: string | null;
  /** The requested native Claude PermissionRequest hook is present in the
   * rendered config. This says configuration only, never connectivity. */
  approvalsConfigured: boolean;
}

export interface HostConfigInspection {
  /** `configured` means at least one complete current handler is present.
   * `readable` is a valid, inspectable file without one; it is distinct from
   * an absent file and from bytes whose structure cannot be trusted. */
  state: 'absent' | 'configured' | 'readable' | 'unreadable';
  notificationConfigured: boolean;
  approvalsConfigured: boolean;
}

function inspectJsonHostConfig(
  surface: Exclude<SetupSurface, 'codex'>,
  existing: string,
  account: string,
  entry: string,
): Pick<HostConfigInspection, 'notificationConfigured' | 'approvalsConfigured'> {
  const root = parseJsonConfig(existing);
  if (root.hooks !== undefined && !isRecord(root.hooks)) {
    throw new Error('invalid hooks table');
  }
  const hooks = isRecord(root.hooks) ? root.hooks : {};
  const command = notifyCommand(surface, account, entry);
  let notificationConfigured = false;
  let approvalsConfigured = false;
  switch (surface) {
    case 'claude-code':
      for (const key of ['Stop', 'Notification', 'PermissionRequest']) {
        if (hooks[key] !== undefined && !Array.isArray(hooks[key])) {
          throw new Error('invalid Claude hook list');
        }
      }
      notificationConfigured =
        hasExactGroupedHook(hooks.Stop, command, { host: 'claude' }) &&
        hasExactGroupedHook(hooks.Notification, command, {
          host: 'claude',
          matcher: CLAUDE_NOTIFICATION_MATCHER,
        });
      approvalsConfigured = hasExactClaudePermission(
        hooks.PermissionRequest,
        account,
        entry,
      );
      break;
    case 'gemini':
      if (hooks.AfterAgent !== undefined && !Array.isArray(hooks.AfterAgent)) {
        throw new Error('invalid Gemini hook list');
      }
      notificationConfigured = hasExactGroupedHook(hooks.AfterAgent, command, {
        host: 'gemini',
      });
      break;
    case 'cursor':
      for (const key of ['afterAgentResponse', 'stop']) {
        if (hooks[key] !== undefined && !Array.isArray(hooks[key])) {
          throw new Error('invalid Cursor hook list');
        }
      }
      notificationConfigured =
        hasExactCursorHook(hooks.afterAgentResponse, command) &&
        hasExactCursorHook(hooks.stop, command);
      break;
  }
  return { notificationConfigured, approvalsConfigured };
}

function inspectCodexHostConfig(
  existing: string,
  account: string,
  entry: string,
): boolean {
  const { lines } = splitTomlOrRefuse(existing);
  const structural = structuralTomlLines(lines);
  const firstTable = lines.findIndex((line, index) =>
    (structural[index] ?? false) && /^\s*\[/.test(line),
  );
  const topLevel = firstTable === -1 ? lines.length : firstTable;
  const notifyAts: number[] = [];
  for (let index = 0; index < topLevel; index += 1) {
    if (!structural[index]) continue;
    const path = parseAssignmentKeyLine(lines[index] ?? '');
    if (path !== null && path[0] === 'notify') notifyAts.push(index);
  }
  if (notifyAts.length === 0) return false;
  if (notifyAts.length !== 1) throw new Error('duplicate Codex notify keys');
  const at = notifyAts[0] as number;
  const path = parseAssignmentKeyLine(lines[at] ?? '');
  if (path === null || path.length !== 1) return false;
  let end = at + 1;
  while (end < lines.length && !structural[end]) end += 1;
  const argv = parseCodexNotifyArgv(lines.slice(at, end).join('\n'));
  if (argv === null) throw new Error('unreadable Codex notify argv');
  let plan: CodexNotifyPlanV1 | null;
  try {
    plan = planFromCodexNotifyDispatchArgv(argv, {
      nodePath: process.execPath,
      entryPath: entry,
    });
  } catch {
    return false;
  }
  return plan?.account === account;
}

/** Observe a host file without merging or writing it. This reader recognizes
 * only the complete current executable/entry/account registration, so setup
 * and doctor never advertise a capability from a lookalike command or a
 * partly edited hook. */
export function inspectHostConfig(
  surface: SetupSurface,
  account: string,
  io: HostConfigIo = {},
): HostConfigInspection {
  const target = io.targetPath ?? hostConfigPathFor(surface);
  let existing: string | null;
  try {
    ({ existing } = readConfigForEdit(target));
  } catch {
    return {
      state: 'unreadable',
      notificationConfigured: false,
      approvalsConfigured: false,
    };
  }
  if (existing === null) {
    return {
      state: 'absent',
      notificationConfigured: false,
      approvalsConfigured: false,
    };
  }
  const entry = io.entryPath ?? builtEntryPath();
  let notificationConfigured = false;
  let approvalsConfigured = false;
  try {
    if (surface === 'codex') {
      notificationConfigured = inspectCodexHostConfig(existing, account, entry);
    } else {
      ({ notificationConfigured, approvalsConfigured } = inspectJsonHostConfig(
        surface,
        existing,
        account,
        entry,
      ));
    }
  } catch {
    return {
      state: 'unreadable',
      notificationConfigured: false,
      approvalsConfigured: false,
    };
  }
  if (!existsSync(entry)) {
    notificationConfigured = false;
    approvalsConfigured = false;
  }
  return {
    state: notificationConfigured || approvalsConfigured ? 'configured' : 'readable',
    notificationConfigured,
    approvalsConfigured,
  };
}

/** Everything `writeHostConfig` needs, computed without writing: the merge
 * itself is the check, so every refusal the write can make happens here. */
interface RenderedHostConfig {
  entry: string;
  target: string;
  existing: string | null;
  /** The opened file's mode (fstat on the SAME fd the content came from —
   * never a third resolution of the path); 0o644 for a fresh file. */
  mode: number;
  merged: string;
  approvalsConfigured: boolean;
}

function renderHostConfig(
  surface: SetupSurface,
  account: string,
  io: HostConfigIo = {},
  options: HostConfigOptions = {},
): RenderedHostConfig {
  const entry = io.entryPath ?? builtEntryPath();
  if (!existsSync(entry)) {
    throw new CliError(
      EXIT.ERROR,
      `${entry} does not exist — build it first: pnpm --filter @tacendum/cli build. ` +
        'A hook pointing at a missing file fails inside the host with no diagnostic surface',
    );
  }
  const target = io.targetPath ?? hostConfigPathFor(surface);
  // One symlink-refusing open; content and mode from that fd (mcp-install's
  // readConfigForEdit, and its reasoning): the old existsSync → readFileSync
  // → copyFileSync → statSync sequence resolved the path four times, so a
  // swap between any two put a DIFFERENT file's content into the backup —
  // or, via a planted symlink, some other file's secrets — while a
  // symlinked target had its link silently replaced by a regular file.
  const { existing, mode } = readConfigForEdit(target);

  const approval = options.claudePermission;
  if (approval !== undefined && surface !== 'claude-code') {
    throw new CliError(
      EXIT.USAGE,
      'the native Claude approval hook can only be configured for claude-code',
    );
  }
  if (
    approval !== undefined &&
    (!Number.isSafeInteger(approval.minimumAppBuild) || approval.minimumAppBuild < 1)
  ) {
    throw new CliError(
      EXIT.USAGE,
      'the native Claude approval app build must be a positive whole number',
    );
  }
  let merged: string;
  switch (surface) {
    case 'claude-code':
      merged = mergeClaudeSettings(
        existing,
        notifyCommand(surface, account, entry),
        approval === undefined
          ? undefined
          : claudePermissionCommand(account, approval.minimumAppBuild, entry),
      );
      break;
    case 'gemini':
      merged = mergeGeminiSettings(existing, notifyCommand(surface, account, entry));
      break;
    case 'cursor':
      merged = mergeCursorHooks(existing, notifyCommand(surface, account, entry));
      break;
    case 'codex':
      merged = mergeCodexNotify(existing, notifyArgv(surface, account, entry), io);
      break;
  }
  const approvalsConfigured =
    surface === 'claude-code' && hasConfiguredClaudePermission(merged, account, entry);
  return { entry, target, existing, mode, merged, approvalsConfigured };
}

/**
 * Every refusal the config write can make, taken WITHOUT writing: the built
 * artifact exists, AND the existing config parses and merges — this is the
 * whole of `renderHostConfig`, result discarded, not merely an existence
 * check. It used to check only the artifact, so an unparseable config or a
 * foreign codex `notify` was discovered after registration, binding and both
 * messages — the exact half-completed state setup's preflight promises to
 * refuse. What this still cannot promise: the file can change, or the disk
 * fill, between this check and the final write; setup's state notes are the
 * honest answer to those late failures.
 */
export function preflightHostConfig(
  surface: SetupSurface,
  account: string,
  io: HostConfigIo = {},
  options: HostConfigOptions = {},
): { entry: string; target: string; approvalsConfigured: boolean } {
  const { entry, target, approvalsConfigured } = renderHostConfig(surface, account, io, options);
  return { entry, target, approvalsConfigured };
}

/** One lock per TARGET file, under tacendum's own home — never inside the
 * host's directory, where a lock dir would be litter another tool has to
 * puzzle over. Serializes tacendum against tacendum only; the host takes no
 * lock of ours. */
function hostConfigLockPath(target: string): string {
  const key = createHash('sha256').update(target).digest('hex').slice(0, 16);
  return join(tacendumHome(), 'locks', `hostconfig.${key}.lock`);
}

/**
 * Merge the surface's hook registration into the host's config file.
 * Merge FIRST, then backup, then write — a refused merge touches nothing,
 * and an unchanged merge writes nothing (and litters no backup).
 *
 * The read and the write happen under one per-target lock, so two tacendum
 * processes cannot merge from the same snapshot and have the second erase
 * the first's entry. The write itself goes through the repo's atomic writer
 * (temp file, fsync, rename — `writeFileAtomic`): a bare `writeFileSync`
 * truncates before it writes, so ENOSPC or a crash mid-write left the HOST's
 * config empty or partial (F20). The host itself takes no lock of ours, so a
 * host that writes between our read and our rename can still lose its edit —
 * the rename narrows that window to nothing we can help, and guarantees the
 * host always reads some COMPLETE config, never a torn one.
 */
export function writeHostConfig(
  surface: SetupSurface,
  account: string,
  io: HostConfigIo = {},
  options: HostConfigOptions = {},
): HostConfigOutcome {
  const preTarget = io.targetPath ?? hostConfigPathFor(surface);
  return withFileLock(hostConfigLockPath(preTarget), () => {
    const { target, existing, mode, merged, approvalsConfigured } = renderHostConfig(
      surface,
      account,
      io,
      options,
    );
    if (existing === merged) {
      return { path: target, changed: false, backup: null, approvalsConfigured };
    }

    mkdirSync(dirname(target), { recursive: true });
    let backup: string | null = null;
    if (existing !== null) {
      // ONE rolling backup, written FROM THE BYTES ALREADY READ, at 0600
      // (tightened further if the original was tighter) — mcp-install's
      // reasoning, same file kinds: `~/.claude/settings.json` and
      // `~/.codex/config.toml` carry other tools' hooks and servers, keys
      // and tokens included, and a timestamped copy per changed run was an
      // unbounded, world-readable archive of them. `copyFileSync(target, …)`
      // additionally re-read the PATH, so a swap after our read backed up a
      // file we never inspected.
      backup = `${target}.bak`;
      writeFileAtomic(backup, existing, { mode: mode & 0o600 });
    }
    // The host's file keeps the host's permissions: the temp file's mode is
    // what survives the rename, and forcing our key-material 0600 onto
    // another tool's config would be a silent permissions change.
    writeFileAtomic(target, merged, { mode: existing !== null ? mode : 0o644 });
    return { path: target, changed: true, backup, approvalsConfigured };
  });
}
