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

/** Same test for the codex TOML argv form, where the words are separate
 * strings rather than one shell line. Requires OUR tag and the `--account`
 * flag, not merely the words `"notify", "--hook"` — a foreign
 * `notify = ["acme", "notify", "--hook", "slack"]` is another notifier's
 * line, and matching it here would silently REPLACE it (the refusal branch
 * in `mergeCodexNotify` only protects lines this predicate rejects). */
function isOurNotifyToml(line: string): boolean {
  return /"notify",\s*"--hook",\s*"(claude|codex|gemini|cursor)",\s*"--account"/.test(line);
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
function withOurEntry(list: unknown, key: string, entry: Record<string, unknown>): unknown[] {
  if (list !== undefined && !Array.isArray(list)) {
    throw new CliError(
      EXIT.ERROR,
      `the existing config's ${key} is not a list — refusing to overwrite it`,
    );
  }
  const kept = withoutOurEntries((list as unknown[] | undefined) ?? []);
  kept.push(entry);
  return kept;
}

/** The filter half of `withOurEntry`, alone — for a list we used to write
 * into and no longer do (gemini's `Stop`), where ours must go and nothing
 * may be appended. */
function withoutOurEntries(list: unknown[]): unknown[] {
  const kept: unknown[] = [];
  for (const item of list) {
    if (!isRecord(item)) {
      kept.push(item);
      continue;
    }
    // Flat shape: the command sits on the item itself.
    if (isOurNotifyCommand(item.command)) continue;
    // Group shape: the commands sit one level down. Filter only ours out of
    // the group; a group that held ONLY ours disappears with them.
    if (Array.isArray(item.hooks)) {
      const hooks = item.hooks.filter(h => !(isRecord(h) && isOurNotifyCommand(h.command)));
      if (hooks.length === 0 && item.hooks.length > 0) continue;
      kept.push(hooks.length === item.hooks.length ? item : { ...item, hooks });
      continue;
    }
    kept.push(item);
  }
  return kept;
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
export function mergeClaudeSettings(existing: string | null, command: string): string {
  const root = parseJsonConfig(existing);
  const hooks = hooksTable(root);
  hooks.Stop = withOurEntry(hooks.Stop, 'hooks.Stop', claudeHookGroup(command));
  hooks.Notification = withOurEntry(
    hooks.Notification,
    'hooks.Notification',
    claudeHookGroup(command, CLAUDE_NOTIFICATION_MATCHER),
  );
  root.hooks = hooks;
  return `${JSON.stringify(root, null, 2)}\n`;
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
 * A foreign `notify` is a REFUSAL, not a replacement: Codex has exactly one
 * notify slot, and overwriting it silently disconnects whatever notifier the
 * operator already trusts. The refusal names the line to add by hand; the
 * existing value is never echoed (it is argv the operator wrote — the same
 * reason args.ts never echoes an unknown token).
 */
export function mergeCodexNotify(existing: string | null, argv: string[]): string {
  const ourLine = codexNotifyLine(argv);
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
    if (notifyAts.some(at => !isOurNotifyToml(lines[at] ?? ''))) {
      throw new CliError(
        EXIT.ERROR,
        'config.toml already sets a top-level `notify` for another notifier — refusing to ' +
          `replace it. To switch to tacendum, change that line yourself to:\n${ourLine}`,
      );
    }
    // Every notify line is provably ours, and each is replaced or dropped
    // WITH ITS WHOLE EXTENT: a value reflowed across lines continues until
    // the next structural line, and swapping only its first line used to
    // leave the tail of the old array dangling — invalid TOML. The first
    // becomes the fresh line; any later one is the duplicate the old text
    // match appended — dropped, which repairs the file without touching
    // anything that is not ours.
    const extentEnd = (at: number): number => {
      let e = at + 1;
      while (e < lines.length && !structural[e]) e += 1;
      return e;
    };
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
}

export interface HostConfigOutcome {
  path: string;
  /** False when the file already said exactly this — the idempotent re-run. */
  changed: boolean;
  backup: string | null;
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
}

function renderHostConfig(
  surface: SetupSurface,
  account: string,
  io: HostConfigIo = {},
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

  let merged: string;
  switch (surface) {
    case 'claude-code':
      merged = mergeClaudeSettings(existing, notifyCommand(surface, account, entry));
      break;
    case 'gemini':
      merged = mergeGeminiSettings(existing, notifyCommand(surface, account, entry));
      break;
    case 'cursor':
      merged = mergeCursorHooks(existing, notifyCommand(surface, account, entry));
      break;
    case 'codex':
      merged = mergeCodexNotify(existing, notifyArgv(surface, account, entry));
      break;
  }
  return { entry, target, existing, mode, merged };
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
): { entry: string; target: string } {
  const { entry, target } = renderHostConfig(surface, account, io);
  return { entry, target };
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
): HostConfigOutcome {
  const preTarget = io.targetPath ?? hostConfigPathFor(surface);
  return withFileLock(hostConfigLockPath(preTarget), () => {
    const { target, existing, mode, merged } = renderHostConfig(surface, account, io);
    if (existing === merged) return { path: target, changed: false, backup: null };

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
    return { path: target, changed: true, backup };
  });
}
