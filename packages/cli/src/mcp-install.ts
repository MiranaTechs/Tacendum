import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  type Stats,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic } from './atomic-write.js';
import { CliError, EXIT } from './exit.js';
import { loadProfile, profilePath } from './profile.js';
import {
  parseAssignmentKeyLine,
  parseTableHeaderLine,
  pathEquals,
  pathStartsWith,
  scanTomlStructure,
  splitTomlLines,
} from './toml-keys.js';

/**
 * `tacendum mcp install`: host configuration, GENERATED
 * rather than documented. A README's config block drifts the day a flag
 * changes; a command that prints the block from the same source tree that
 * parses it cannot.
 *
 * Print mode owns stdout — this subcommand is NOT the server, so the "stdout
 * is the transport" rule does not bind it, and the block has to be pipeable
 * (`tacendum mcp install --host codex >> ~/.codex/config.toml` should work).
 *
 * `--write` merges rather than writes, and the distinction carries the whole
 * risk: these are files OTHER tools own. `claude_desktop_config.json` holds
 * every other MCP server the operator uses; `~/.codex/config.toml` holds
 * their model and approval settings. Clobbering an unrelated key would break
 * a tool this CLI has never heard of, so the merge touches exactly one key
 * (`mcpServers.tacendum` / `[mcp_servers.tacendum]`), backs the file up
 * first, and REFUSES a file it cannot parse instead of guessing.
 */

export type McpHost = 'claude-desktop' | 'claude-code' | 'codex';
const HOSTS: readonly string[] = ['claude-desktop', 'claude-code', 'codex'];

const USAGE =
  'usage: tacendum mcp install --host claude-desktop|claude-code|codex [--account <name>] [--write]';

/** Present in every printed block, because a config file is where the NEXT
 * person meets this server: it must say what the server cannot do — and the
 * one destructive thing it CAN do — before anyone has to trust it. It used to
 * say "read-only", which was false: acknowledging starts the retention clock
 * that purges those bodies from local disk. It states BOTH
 * launch modes, because a sentence claiming "no send capability" outright
 * would be false the day an operator adds `--notify-owner` to this very
 * block — the honest form names the flag and what it unlocks. */
const CAPABILITY_NOTE =
  'As configured here the tacendum MCP server has no send capability and ' +
  'makes no network calls: it reports the account id and reads the local ' +
  'message log. Its one write is acknowledge, which marks messages read and ' +
  'starts the retention clock that purges those bodies from local disk. ' +
  'Adding --notify-owner to the args registers one send tool, ' +
  'tacendum_notify_owner, which dials the network and can message ONLY the ' +
  "account's bound owner — the recipient is enforced server-side.";

export interface McpInstallOptions {
  host: string | undefined;
  account: string | undefined;
  write: boolean;
}

/** Test seams, doctor.ts-style: the merge logic is worth testing against
 * temp files, and a unit test must never touch the real `~/Library`. */
export interface InstallIo {
  entryPath?: string;
  targetPath?: string;
}

/**
 * The built artifact, resolved from THIS module's location — never the cwd,
 * which under an MCP host is whatever directory the host launched from.
 * Dual life, same reasoning as version.ts: under tsx this file is `src/…`
 * and the artifact lives in `../dist`; bundled, this file IS dist/main.js.
 */
export function builtEntryPath(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return basename(moduleDir) === 'src'
    ? join(dirname(moduleDir), 'dist', 'main.js')
    : join(moduleDir, 'main.js');
}

export function configPathFor(host: McpHost): string {
  switch (host) {
    case 'claude-desktop':
      return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    case 'claude-code':
      // Project scope: `.mcp.json` where the operator is standing. Here the
      // cwd IS the right anchor — that is what "project scope" means.
      return join(process.cwd(), '.mcp.json');
    case 'codex':
      return join(homedir(), '.codex', 'config.toml');
  }
}

interface ServerSpec {
  command: string;
  args: string[];
}

function serverSpec(entry: string, account: string): ServerSpec {
  // `process.execPath`, not "node": Claude Desktop is a .app launched by
  // launchd with a PATH that has never seen nvm or Herd, so a bare "node"
  // resolves to nothing and the server "fails to start" with no diagnostic
  // surface. The interpreter path is machine-specific — and so is every
  // other absolute path in these config files.
  return { command: process.execPath, args: [entry, 'mcp', '--account', account] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Merge the tacendum entry into an existing JSON config, preserving every
 * unrelated key AND every unrelated server under `mcpServers`. A file that
 * does not parse is a refusal, not a guess: the likeliest cause is a hand
 * edit mid-thought, and "my other three MCP servers vanished" is the failure
 * this function exists to make impossible.
 */
export function mergeJsonConfig(existing: string | null, spec: ServerSpec): string {
  let root: Record<string, unknown> = {};
  if (existing !== null && existing.trim() !== '') {
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
      throw new CliError(
        EXIT.ERROR,
        'the existing config is not a JSON object — refusing to overwrite it',
      );
    }
    root = parsed;
  }
  const servers = isRecord(root.mcpServers) ? root.mcpServers : {};
  servers.tacendum = spec; // exactly one key; everything else survives
  root.mcpServers = servers;
  return `${JSON.stringify(root, null, 2)}\n`;
}

/** A TOML basic string. Paths are the only values escaped here, but a `"`
 * or `\` in one would otherwise silently produce a config the host rejects. */
function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** The comment lives INSIDE the section on purpose: the replace-on-rewrite
 * below spans header-to-next-header, so a comment above the header would
 * duplicate on every re-run. */
export function renderTomlSection(spec: ServerSpec): string {
  return [
    '[mcp_servers.tacendum]',
    `# ${CAPABILITY_NOTE}`,
    `command = ${tomlString(spec.command)}`,
    `args = [${spec.args.map(tomlString).join(', ')}]`,
  ].join('\n');
}

/** The one key this merge owns, as a PARSED path. Identity is decided
 * against parsed paths, never against header bytes — `[mcp_servers.tacendum]`,
 * `[mcp_servers."tacendum"]`, `['mcp_servers'.'tacendum']` and
 * `[ mcp_servers . tacendum ]` are four spellings of this one key. */
const TOML_TARGET: readonly string[] = ['mcp_servers', 'tacendum'];

/**
 * Split TOML text into \r-free lines plus the newline that must rejoin
 * them, refusing mixed endings. CRLF is where the duplicate-table bug
 * an earlier merge fix closed came BACK: split on \n alone and every header keeps a
 * trailing \r, `[mcp_servers.tacendum]\r` parses as no header, and the
 * merge appends a second table for a key the file already has. The file's
 * own ending must also SURVIVE the merge — rewriting a CRLF config as LF is
 * a whole-file diff in a file other tools own, and mixing endings is worse.
 * Shared with hostconfig.ts's codex merge, which splits the same files.
 */
export function splitTomlOrRefuse(raw: string): { lines: string[]; eol: '\n' | '\r\n' } {
  const split = splitTomlLines(raw);
  if (split === null) {
    throw new CliError(
      EXIT.ERROR,
      'the existing config mixes line endings (\\r\\n and \\n, or a bare \\r) — a merge ' +
        'would either rewrite untouched lines or emit mixed endings; normalize the file first',
    );
  }
  return split;
}

/**
 * The lexical line map for a file about to be merged, or a refusal: a file
 * that ends inside an unterminated string/bracket, or holds a line that does
 * not lex, is not valid TOML — the host will reject it whatever we write,
 * and every structural judgement about it would be a guess. Shared with
 * hostconfig.ts's codex merge for the same reason as `splitTomlOrRefuse`.
 */
export function structuralTomlLines(lines: readonly string[]): boolean[] {
  const scan = scanTomlStructure(lines);
  if (scan.malformedAt !== null || scan.openAtEof) {
    throw new CliError(
      EXIT.ERROR,
      'the config has an unterminated string or bracket — not valid TOML; refusing to ' +
        'guess at a merge. Fix or move the file first',
    );
  }
  return scan.structural;
}

/**
 * One structural pass over the file: every `[table]` header parsed to the
 * key path it defines, returning the [start, end) line range of every
 * section that IS the target key — under any spelling. The pass also
 * REFUSES (throws) the two shapes a `[mcp_servers.tacendum]` table cannot
 * legally join, because appending one there is how the merge used to hand
 * the host an unparseable file:
 *
 *  - the target (or `mcp_servers` itself) as an `[[array of tables]]`;
 *  - the target reached by ASSIGNMENT from above it — a top-level dotted
 *    `mcp_servers.tacendum.command = …`, a top-level inline
 *    `mcp_servers = {…}`, or `tacendum = {…}` inside `[mcp_servers]`.
 *
 * Every judgement here consults the LEXICAL line map first: a line inside a
 * multiline string or a reflowed array is value content, and reading it as
 * syntax was this scanner's worst defect — a `[mcp_servers.tacendum]` line
 * inside a """docstring""" scanned as a real section, the merge spliced the
 * string's middle out, and the host got invalid TOML under a success
 * message. Structural bracket lines that still do not parse as headers keep
 * their old meaning — a section boundary, nothing more: they cannot spell
 * the target key, but they DO make the table context unknowable
 * line-by-line, so assignment checking pauses until the next real header.
 */
function scanTomlForTarget(lines: readonly string[]): Array<{ start: number; end: number }> {
  const structural = structuralTomlLines(lines);
  const isBoundary = (i: number): boolean =>
    (structural[i] ?? false) && /^\s*\[/.test(lines[i] ?? '');
  const sections: Array<{ start: number; end: number }> = [];
  let table: readonly string[] | null = []; // table path in force; null = unknown
  for (let i = 0; i < lines.length; i += 1) {
    if (!structural[i]) continue; // value content — never syntax
    const line = lines[i] ?? '';
    if (/^\s*\[/.test(line)) {
      const header = parseTableHeaderLine(line);
      if (header === null) {
        table = null;
        continue;
      }
      if (header.array && pathStartsWith(TOML_TARGET, header.path)) {
        throw new CliError(
          EXIT.ERROR,
          'the existing config defines mcp_servers as an [[array of tables]] — a ' +
            '[mcp_servers.tacendum] table cannot legally join it; refusing to merge. ' +
            'Remove or rename that entry, then re-run',
        );
      }
      table = header.path;
      if (!header.array && pathEquals(header.path, TOML_TARGET)) {
        // The section runs to the next STRUCTURAL bracket line: a bracket
        // that merely opens an array element mid-value is content, and
        // ending the section there left the array's tail dangling after the
        // replacement — invalid TOML under a success message.
        let end = i + 1;
        while (end < lines.length && !isBoundary(end)) end += 1;
        sections.push({ start: i, end });
      }
      continue;
    }
    // Assignments can only re-spell the target from ABOVE it: at the top
    // level or inside [mcp_servers]. Inside the target's own section the
    // body is ours to replace; from an unrelated table no key can reach it.
    if (table === null || !pathStartsWith(TOML_TARGET, table) || table.length >= TOML_TARGET.length) {
      continue;
    }
    const lhs = parseAssignmentKeyLine(line);
    if (lhs === null) continue;
    const absolute = [...table, ...lhs];
    const collides =
      pathStartsWith(absolute, TOML_TARGET) ||
      (pathStartsWith(TOML_TARGET, absolute) && absolute.length < TOML_TARGET.length);
    if (collides) {
      throw new CliError(
        EXIT.ERROR,
        'the existing config already defines mcp_servers.tacendum as a dotted or inline ' +
          'key, which a [mcp_servers.tacendum] table cannot legally join — refusing to ' +
          'append a duplicate. Move that entry into a [mcp_servers.tacendum] section ' +
          '(or remove it), then re-run',
      );
    }
  }
  return sections;
}

/** The outcome guard: whatever the merge produced, the target key must scan
 * as defined EXACTLY once before a byte is written (and, re-run by
 * runMcpInstall, once more on the bytes the host will read). \r\n is
 * normalized before scanning so a CRLF spelling of a duplicate header
 * cannot hide from the very guard that exists to catch duplicates; a file
 * so damaged it no longer lexes throws out of `structuralTomlLines`, which
 * is the same loud failure. Throwing here means a bug above — and a
 * CliError instead of a corrupted host config. */
function assertTomlTargetOnce(merged: string): void {
  const sections = scanTomlForTarget(merged.replace(/\r\n/g, '\n').split('\n'));
  if (sections.length !== 1) {
    throw new CliError(
      EXIT.ERROR,
      `internal: the merged config defines mcp_servers.tacendum ${sections.length} times — refusing to write it`,
    );
  }
}

/**
 * Merge without a TOML value parser: replace the target section (header to
 * the next table header, comment included) if present, else append. Still
 * line-based on purpose — parsing and re-serialising the whole file would
 * normalise the operator's formatting and comments everywhere, which is a
 * rewrite wearing a merge's name. But PRESENCE is decided semantically, by
 * `scanTomlForTarget` above: the old textual match recognised only the bare
 * spelling, so an existing `[mcp_servers."tacendum"]` got a second table
 * appended for the same key and the host's config stopped parsing. If the
 * file already holds several spellings of the section (that old bug's
 * leavings), the first becomes the fresh section and the rest are dropped —
 * every one of them is the same key this merge owns, superseded by the one
 * section it writes, so the repair guesses at nothing.
 */
export function mergeTomlConfig(existing: string | null, section: string): string {
  const { lines, eol } = splitTomlOrRefuse(existing ?? '');
  const text = lines.join('\n'); // \r-free; `eol` restores the file's own ending on the way out
  const sections = scanTomlForTarget(lines);

  let merged: string;
  if (sections.length === 0) {
    merged = text.trim() === '' ? `${section}\n` : `${text.replace(/\n*$/, '')}\n\n${section}\n`;
  } else {
    const out: string[] = [];
    let placed = false;
    let i = 0;
    while (i < lines.length) {
      const hit = sections.find((s) => s.start === i);
      if (hit === undefined) {
        out.push(lines[i] ?? '');
        i += 1;
        continue;
      }
      if (!placed) {
        out.push(...section.split('\n'));
        placed = true;
      }
      i = hit.end;
    }
    merged = out.join('\n');
    if (!merged.endsWith('\n')) merged = `${merged}\n`;
  }
  const restored = eol === '\n' ? merged : merged.replace(/\n/g, eol);
  assertTomlTargetOnce(restored);
  return restored;
}

/**
 * Read a config file for editing: ONE open of the path, everything after it
 * against the file descriptor. The sequence used to be lstat → readFileSync
 * (path) → copyFileSync(path, backup) — three separate resolutions of the
 * same name, so a swap landing between any two of them made the backup (and
 * the merge's notion of "existing") describe a DIFFERENT file than the one
 * inspected; a swap to a symlink made copyFileSync follow it and copy some
 * other file's content into a world-readable backup. Now: lstat refuses a
 * symlink by name (clear message, catches dangling links), the open itself
 * carries O_NOFOLLOW so a link planted after the lstat is refused too, and
 * mode + content both come from fstat/read on that one fd. The backup is
 * later written FROM THESE BYTES, never by re-reading the path — so
 * whatever races, backup, merge input and verification all describe the one
 * file this function opened.
 *
 * Shared with hostconfig.ts, which had the same sequence (plus a third
 * statSync resolution for the mode) and not even the lstat.
 *
 * ENOENT from the OPEN is not ENOENT from the lstat. The lstat saying
 * "no file" is the legitimate fresh-create path; the open saying it AFTER
 * the lstat observed the file means it vanished in the gap — and the
 * likeliest author of that vanish is a concurrent editor mid save (many
 * save exactly as delete-then-recreate, or rename-over). This used to be
 * downgraded to the same `{ existing: null }` fresh-create state, which
 * composed into the worst pair both callers can produce: the merge ran
 * from EMPTY and rename-clobbered whatever the editor had just re-saved,
 * while the null `existing` doubled as the "nothing to back up" signal —
 * so the one copy that would have survived was never written. A file this
 * function has OBSERVED is never reported absent: the vanish is a refusal
 * (re-run when the editor settles), not a state. No retry, deliberately —
 * re-reading mid save would merge from a file another tool is between
 * writes on, which is a guess wearing a recovery's name.
 */
export function readConfigForEdit(target: string): { existing: string | null; mode: number } {
  let stat: Stats | null;
  try {
    stat = lstatSync(target);
  } catch {
    stat = null; // no file yet — the fresh-create path
  }
  if (stat?.isSymbolicLink()) {
    throw new CliError(
      EXIT.ERROR,
      `${target} is a symbolic link — refusing to follow it; run against the real file instead`,
    );
  }
  if (stat === null) return { existing: null, mode: 0o644 };
  let fd: number;
  try {
    fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'EMLINK') {
      // A symlink planted between the lstat and the open: same refusal.
      throw new CliError(
        EXIT.ERROR,
        `${target} is a symbolic link — refusing to follow it; run against the real file instead`,
      );
    }
    if (code === 'ENOENT') {
      // Deleted since the lstat — an observed file, gone. See the doc above:
      // this is a concurrent edit in progress, never a fresh-create.
      throw new CliError(
        EXIT.ERROR,
        `${target} disappeared while being read — another program is editing it right now ` +
          '(delete-and-resave is how most editors write); nothing was changed. Re-run when it settles',
      );
    }
    throw err;
  }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) {
      throw new CliError(EXIT.ERROR, `${target} is not a regular file — refusing to edit it`);
    }
    return { existing: readFileSync(fd, 'utf8'), mode: opened.mode & 0o777 };
  } finally {
    closeSync(fd);
  }
}

/**
 * Print (and with `--write`, merge) the host config. Returns the printed
 * block so main.ts owns the stdout write and tests can assert on the text
 * without capturing a stream.
 */
export function runMcpInstall(opts: McpInstallOptions, io: InstallIo = {}): string {
  const host = opts.host;
  if (host === undefined || !HOSTS.includes(host)) {
    throw new CliError(EXIT.USAGE, USAGE);
  }
  const account = opts.account;
  if (account !== undefined) {
    // Shape check only (throws on an illegal client name). A config block
    // carrying a name the CLI itself would refuse helps nobody.
    profilePath(account);
  }

  const entry = io.entryPath ?? builtEntryPath();
  const target = io.targetPath ?? configPathFor(host as McpHost);

  if (opts.write) {
    if (account === undefined) {
      throw new CliError(
        EXIT.USAGE,
        '--write needs --account <name>: the server refuses to start without ' +
          'one, so a config without one is a config that cannot work',
      );
    }
    // Same refusal the server itself would issue, moved to install time —
    // a config for an unregistered account fails inside the host, where the
    // only symptom is a greyed-out server.
    loadProfile(account);
    if (!existsSync(entry)) {
      throw new CliError(
        EXIT.ERROR,
        `${entry} does not exist — build it first: pnpm --filter @tacendum/cli build. ` +
          'A config pointing at a missing file fails inside the host with no diagnostic surface',
      );
    }
  } else {
    // Print mode still WARNS about both gaps (stderr, so the block itself
    // stays pipeable), because the printed block is a copy-paste away from
    // being live.
    if (!existsSync(entry)) {
      process.stderr.write(`note: ${entry} is not built yet — run: pnpm --filter @tacendum/cli build\n`);
    }
    if (account === undefined) {
      process.stderr.write('note: no --account given; replace <account> before using this block\n');
    }
  }

  const spec = serverSpec(entry, account ?? '<account>');
  const isToml = host === 'codex';
  const block = isToml
    ? renderTomlSection(spec)
    : JSON.stringify({ mcpServers: { tacendum: spec } }, null, 2);
  // `//` for the JSON hosts, `#` for TOML: neither is written into a JSON
  // file (JSON has no comments), but the printout must carry the capability
  // statement either way — the config is where the next person meets this
  // server.
  const comment = isToml ? '#' : '//';
  const printed = [
    `${comment} ${opts.write ? 'merged into' : 'merge into'}: ${target}`,
    `${comment} ${CAPABILITY_NOTE}`,
    block,
  ].join('\n');

  if (opts.write) {
    // One open, symlink-refusing (`readConfigForEdit`): for claude-code the
    // target is `.mcp.json` in whatever directory the operator is standing
    // in, and a hostile checkout can plant a symlink there. Following it
    // would copy the linked-to file's content into a backup beside the link
    // (disclosure) and then replace the linked-to file itself (a write
    // outside the project). A dangling link is refused for the same reason
    // — writing "through" it would create the file it points at.
    const { existing, mode } = readConfigForEdit(target);
    // Merge FIRST: if the existing file is refused, nothing has been touched
    // — no backup litter, no half-done install.
    const merged = isToml ? mergeTomlConfig(existing, block) : mergeJsonConfig(existing, spec);
    if (merged !== existing) {
      mkdirSync(dirname(target), { recursive: true });
      let backup: string | null = null;
      if (existing !== null) {
        // ONE rolling backup, not an accumulating series: this file holds
        // OTHER servers' credentials (env API keys, tokens), and a
        // timestamped `.bak.<stamp>` per changed run was multiplying the
        // on-disk copies of secrets we do not own, at the source file's own
        // (commonly world-readable) mode, in a directory nobody thinks of
        // as secret-bearing. `.bak` is overwritten in place, written 0600
        // (tightened further if the original was tighter), and written FROM
        // THE BYTES JUST READ — never by re-reading the path, which is what
        // let a concurrent swap put some other file's content into it. An
        // unchanged run still writes nothing at all.
        backup = `${target}.bak`;
        writeFileAtomic(backup, existing, { mode: mode & 0o600 }, 'crash-consistent');
        process.stderr.write(`backup: ${backup}\n`);
      }
      // Temp in the SAME directory + rename (atomic-write.ts): a crash
      // mid-write must never leave a truncated config that silently disables
      // every OTHER server in the file. The existing file's mode survives
      // the replace; a fresh file takes the conventional 0644, not the key
      // material 0600 — this is a host config, not a secret.
      writeFileAtomic(
        target,
        merged,
        { mode: existing !== null ? mode : 0o644 },
        'crash-consistent',
      );
      // The outcome guard, on the BYTES THE HOST WILL READ: re-read the file
      // and verify — a JSON parse for the JSON hosts, the key-identity scan
      // for TOML. The atomic write makes failure here nearly impossible,
      // which is exactly why the check is cheap enough to keep: "nearly" is
      // not a property to trust in a file other tools own, and a loud
      // failure that names the backup beats a host that silently stops.
      try {
        const onDisk = readFileSync(target, 'utf8');
        if (isToml) {
          assertTomlTargetOnce(onDisk);
        } else {
          const parsed: unknown = JSON.parse(onDisk);
          if (!(isRecord(parsed) && isRecord(parsed.mcpServers) && isRecord(parsed.mcpServers.tacendum))) {
            throw new Error('tacendum entry missing after merge');
          }
        }
      } catch {
        throw new CliError(
          EXIT.ERROR,
          `${target} failed verification after the merge — do not trust it${
            backup !== null ? `; your previous config is intact at ${backup}` : ''
          }`,
        );
      }
    }
    // An identical re-run is a success, not a change: no backup, no rewrite.
    process.stderr.write(`merged into ${target}\n`);
  }

  return printed;
}
