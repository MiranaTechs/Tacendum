/**
 * Host hook configuration (`hostconfig.ts`) — the file-writing half of
 * `tacendum setup`.
 *
 * The property under test throughout is the one mcp-install.ts established
 * and four assistant-host files now depend on: these are files OTHER tools
 * own, so the merge may touch only entries that are provably ours, must
 * refuse what it cannot parse, and must be idempotent — a second run
 * changes nothing, because "run setup again" is the documented remedy for
 * every half-completed state.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliError, EXIT } from '../src/exit.js';
import { parseGeminiHook } from '../src/hooks.js';
import {
  CLAUDE_NOTIFICATION_MATCHER,
  codexNotifyLine,
  mergeClaudeSettings,
  mergeCodexNotify,
  mergeCursorHooks,
  mergeGeminiSettings,
  notifyArgv,
  preflightHostConfig,
  writeHostConfig,
} from '../src/hostconfig.js';

// `writeHostConfig` serializes through a lock under tacendum's home; a unit
// test must never touch the real `~/.tacendum`. Safe to set after the
// imports because config.ts reads TACENDUM_HOME lazily, at each call.
const home = mkdtempSync(join(tmpdir(), 'tacendum-hostconfig-home-'));
process.env.TACENDUM_HOME = home;
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

let dir: string;
let entry: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tacendum-hostconfig-'));
  // A real file, because preflight refuses a missing artifact — and its path
  // carries a space on purpose: the main platform's interpreter path does
  // ("Application Support"), and an unquoted one runs half a path.
  mkdirSync(join(dir, 'dist dir'));
  entry = join(dir, 'dist dir', 'main.js');
  writeFileSync(entry, 'entry');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function io(target: string) {
  return { entryPath: entry, targetPath: join(dir, target) };
}

describe('claude-code settings merge', () => {
  it('registers Stop and a matched Notification hook, async, quoting the spaced path', () => {
    const out = writeHostConfig('claude-code', 'ci', io('settings.json'));
    expect(out.changed).toBe(true);
    const root = JSON.parse(readFileSync(out.path, 'utf8'));
    const stop = root.hooks.Stop;
    const note = root.hooks.Notification;
    expect(stop).toHaveLength(1);
    expect(note).toHaveLength(1);
    expect(note[0].matcher).toBe(CLAUDE_NOTIFICATION_MATCHER);
    for (const group of [stop[0], note[0]]) {
      const hook = group.hooks[0];
      expect(hook.type).toBe('command');
      // Row 6's requirement: the hook must never hold the agent.
      expect(hook.async).toBe(true);
      expect(hook.command).toContain('notify --hook claude --account ci');
      // The spaced entry path is shell-quoted, or the hook runs half a path.
      expect(hook.command).toContain(`'${entry}'`);
    }
  });

  it('preserves unrelated keys and a stranger\'s hooks, and never doubles on re-run', () => {
    const target = join(dir, 'settings.json');
    writeFileSync(
      target,
      JSON.stringify({
        model: 'opus',
        mcpServers: { other: { command: 'x' } },
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'ntfy send done' }] }],
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh' }] }],
        },
      }),
    );
    writeHostConfig('claude-code', 'ci', io('settings.json'));
    const once = readFileSync(target, 'utf8');
    const root = JSON.parse(once);
    // Everything that was there survives, byte-meaning intact.
    expect(root.model).toBe('opus');
    expect(root.mcpServers.other.command).toBe('x');
    expect(root.hooks.PreToolUse[0].hooks[0].command).toBe('guard.sh');
    expect(root.hooks.Stop[0].hooks[0].command).toBe('ntfy send done');
    // Ours appended once.
    expect(root.hooks.Stop).toHaveLength(2);

    // Idempotence is byte-level: a re-run replaces its own entry, nothing else.
    const second = writeHostConfig('claude-code', 'ci', io('settings.json'));
    expect(second.changed).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe(once);
  });

  it('refuses a file that does not parse, touching nothing', () => {
    const target = join(dir, 'settings.json');
    writeFileSync(target, '{ definitely not json');
    expect(() => writeHostConfig('claude-code', 'ci', io('settings.json'))).toThrow(CliError);
    expect(readFileSync(target, 'utf8')).toBe('{ definitely not json');
  });

  it('refuses a hooks list of the wrong shape rather than overwriting it', () => {
    const target = join(dir, 'settings.json');
    writeFileSync(target, JSON.stringify({ hooks: { Stop: { not: 'a list' } } }));
    expect(() => writeHostConfig('claude-code', 'ci', io('settings.json'))).toThrow(/refusing/);
    expect(JSON.parse(readFileSync(target, 'utf8')).hooks.Stop.not).toBe('a list');
  });

  it('backs the file up before the first byte changes, and only when bytes change', () => {
    const target = join(dir, 'settings.json');
    writeFileSync(target, JSON.stringify({ model: 'opus' }));
    const first = writeHostConfig('claude-code', 'ci', io('settings.json'));
    expect(first.backup).not.toBeNull();
    expect(JSON.parse(readFileSync(first.backup as string, 'utf8')).model).toBe('opus');
    // The unchanged re-run litters no second backup.
    writeHostConfig('claude-code', 'ci', io('settings.json'));
    const backups = readdirSync(dir).filter(f => f.includes('.bak'));
    expect(backups).toHaveLength(1);
  });

  it('updates its own entry in place when the account changes', () => {
    writeHostConfig('claude-code', 'ci', io('settings.json'));
    writeHostConfig('claude-code', 'ci2', io('settings.json'));
    const root = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    expect(root.hooks.Stop).toHaveLength(1);
    expect(root.hooks.Stop[0].hooks[0].command).toContain('--account ci2');
    // The old registration is GONE, not shadowed: no command anywhere still
    // names the first account.
    expect(JSON.stringify(root)).not.toMatch(/--account ci"/);
  });
});

describe('codex config.toml merge', () => {
  it('creates the one top-level notify line', () => {
    const out = writeHostConfig('codex', 'ci', io('config.toml'));
    const text = readFileSync(out.path, 'utf8');
    expect(text).toContain('notify = [');
    expect(text).toContain('"notify", "--hook", "codex", "--account", "ci"');
  });

  it('inserts BEFORE the first table header — a notify after one belongs to that table', () => {
    const target = join(dir, 'config.toml');
    writeFileSync(target, 'model = "gpt-5"\n\n[mcp_servers.foo]\ncommand = "x"\n');
    writeHostConfig('codex', 'ci', io('config.toml'));
    const text = readFileSync(target, 'utf8');
    const notifyAt = text.indexOf('notify = [');
    const tableAt = text.indexOf('[mcp_servers.foo]');
    expect(notifyAt).toBeGreaterThan(-1);
    expect(notifyAt).toBeLessThan(tableAt);
    expect(text).toContain('model = "gpt-5"');
    expect(text).toContain('command = "x"');
  });

  it('refuses to replace a stranger\'s notify, without echoing it', () => {
    const target = join(dir, 'config.toml');
    writeFileSync(target, 'notify = ["my-secret-notifier", "hunter2"]\n');
    let thrown: CliError | undefined;
    try {
      writeHostConfig('codex', 'ci', io('config.toml'));
    } catch (err) {
      thrown = err as CliError;
    }
    expect(thrown).toBeInstanceOf(CliError);
    // The refusal explains without quoting: the existing argv is the
    // operator's and could carry a token (the no-leak shape, applied to config).
    expect(thrown?.message).not.toContain('hunter2');
    expect(readFileSync(target, 'utf8')).toContain('my-secret-notifier');
  });

  it('replaces its own line idempotently', () => {
    const target = join(dir, 'config.toml');
    writeHostConfig('codex', 'ci', io('config.toml'));
    const once = readFileSync(target, 'utf8');
    const again = writeHostConfig('codex', 'ci', io('config.toml'));
    expect(again.changed).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe(once);
    // And an account change rewrites the line rather than adding a second.
    writeHostConfig('codex', 'other', io('config.toml'));
    const text = readFileSync(target, 'utf8');
    expect(text.match(/^notify = /gm)).toHaveLength(1);
    expect(text).toContain('"--account", "other"');
  });
});

describe('cursor hooks.json merge', () => {
  it('registers the two-hook dance and keeps the operator\'s version and hooks', () => {
    const target = join(dir, 'hooks.json');
    writeFileSync(
      target,
      JSON.stringify({ version: 2, hooks: { beforeShellExecution: [{ command: 'audit.sh' }] } }),
    );
    writeHostConfig('cursor', 'ci', io('hooks.json'));
    const root = JSON.parse(readFileSync(target, 'utf8'));
    expect(root.version).toBe(2);
    expect(root.hooks.beforeShellExecution[0].command).toBe('audit.sh');
    // Row 12: `stop` lacks the message text, so the same command runs on
    // afterAgentResponse (cache) and stop (send).
    expect(root.hooks.afterAgentResponse[0].command).toContain('notify --hook cursor');
    expect(root.hooks.stop[0].command).toContain('notify --hook cursor');
  });

  it('is idempotent and defaults version to 1 on a fresh file', () => {
    const out = writeHostConfig('cursor', 'ci', io('hooks.json'));
    const once = readFileSync(out.path, 'utf8');
    expect(JSON.parse(once).version).toBe(1);
    expect(writeHostConfig('cursor', 'ci', io('hooks.json')).changed).toBe(false);
    expect(readFileSync(out.path, 'utf8')).toBe(once);
  });
});

describe('gemini settings merge', () => {
  it('registers an AfterAgent hook in GEMINI\'s shape — ms timeout, no async — and is idempotent', () => {
    const out = writeHostConfig('gemini', 'ci', io('settings.json'));
    const root = JSON.parse(readFileSync(out.path, 'utf8'));
    const hook = root.hooks.AfterAgent[0].hooks[0];
    expect(hook.type).toBe('command');
    expect(hook.command).toContain('notify --hook gemini --account ci');
    // Gemini's `timeout` is MILLISECONDS (docs/hooks/reference.md, default
    // 60000) — Claude's `timeout: 10` here would kill the hook after 10ms,
    // before node has even loaded.
    expect(hook.timeout).toBe(10_000);
    // And `async` is Claude's field, not Gemini's — writing it is at best
    // ignored and at worst rejected by a strict settings validator.
    expect(hook.async).toBeUndefined();
    expect(writeHostConfig('gemini', 'ci', io('settings.json')).changed).toBe(false);
  });

  it('writes the event name our OWN gemini hook parser answers to', () => {
    // The installed hook and parseGeminiHook (hooks.ts) are two halves of one
    // contract: the event key written into settings.json must be the
    // hook_event_name the parser turns into a send. `Stop` — what this merge
    // used to write — makes this exact assertion fail: Gemini has no such
    // event, so the installed hook could never fire.
    writeHostConfig('gemini', 'ci', io('settings.json'));
    const root = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    const events = Object.keys(root.hooks);
    expect(events).toHaveLength(1);
    const parsed = parseGeminiHook(
      JSON.stringify({
        hook_event_name: events[0],
        prompt_response: 'done',
        cwd: '/tmp/x',
      }),
    );
    expect(parsed.action).toBe('send');
  });

  it('removes the dead Stop entry earlier builds wrote, keeping a stranger\'s Stop hooks', () => {
    const target = join(dir, 'settings.json');
    writeFileSync(
      target,
      JSON.stringify({
        hooks: {
          Stop: [
            // What an earlier `tacendum setup gemini` installed: Claude's shape
            // under an event Gemini does not have (spaced paths quoted, as
            // `shellWord` has always written them).
            {
              hooks: [
                {
                  type: 'command',
                  command: `'/old/App Support/node' '/old/dist dir/main.js' notify --hook gemini --account ci`,
                  async: true,
                  timeout: 10,
                },
              ],
            },
            { hooks: [{ type: 'command', command: 'ntfy send done' }] },
          ],
        },
      }),
    );
    writeHostConfig('gemini', 'ci', io('settings.json'));
    const root = JSON.parse(readFileSync(target, 'utf8'));
    // Ours moved to the event that exists; the stranger's Stop survives.
    expect(root.hooks.AfterAgent).toHaveLength(1);
    expect(root.hooks.Stop).toHaveLength(1);
    expect(root.hooks.Stop[0].hooks[0].command).toBe('ntfy send done');
    expect(JSON.stringify(root.hooks.Stop)).not.toContain('--hook gemini');
  });
});

describe('preflight', () => {
  it('refuses a missing built artifact with the build remedy — BEFORE anything is written', () => {
    let thrown: CliError | undefined;
    try {
      preflightHostConfig('claude-code', 'ci', {
        entryPath: join(dir, 'nope.js'),
        targetPath: join(dir, 's.json'),
      });
    } catch (err) {
      thrown = err as CliError;
    }
    expect(thrown).toBeInstanceOf(CliError);
    expect(thrown?.exitCode).toBe(EXIT.ERROR);
    expect(thrown?.message).toContain('build');
  });

  it('is the merge, not an existence check: a malformed config refuses at preflight', () => {
    // The docblock's promise is that EVERY refusal the final write can make
    // is made here, before setup registers anything. An existence-only
    // preflight lets an unparseable settings.json and a foreign codex notify
    // through, to fail AFTER pairing — the half-completed state the
    // preflight exists to refuse.
    const settings = join(dir, 'settings.json');
    writeFileSync(settings, '{ definitely not json');
    expect(() =>
      preflightHostConfig('claude-code', 'ci', { entryPath: entry, targetPath: settings }),
    ).toThrow(CliError);
    // Preflight never writes: the malformed file is untouched.
    expect(readFileSync(settings, 'utf8')).toBe('{ definitely not json');

    const toml = join(dir, 'config.toml');
    writeFileSync(toml, 'notify = ["acme", "notify", "--hook", "slack", "--account", "x"]\n');
    expect(() =>
      preflightHostConfig('codex', 'ci', { entryPath: entry, targetPath: toml }),
    ).toThrow(CliError);
  });
});

describe('ownership is an exact entry, not a substring (F6)', () => {
  it('leaves a stranger\'s command containing "notify --hook" untouched in claude groups', () => {
    const target = join(dir, 'settings.json');
    writeFileSync(
      target,
      JSON.stringify({
        hooks: {
          Stop: [
            { hooks: [{ type: 'command', command: '/usr/local/bin/acme notify --hook slack' }] },
          ],
        },
      }),
    );
    writeHostConfig('claude-code', 'ci', io('settings.json'));
    const root = JSON.parse(readFileSync(target, 'utf8'));
    const commands = root.hooks.Stop.flatMap((g: { hooks: Array<{ command: string }> }) =>
      g.hooks.map(h => h.command),
    );
    // The acme hook survives; ours is appended beside it.
    expect(commands).toContain('/usr/local/bin/acme notify --hook slack');
    expect(commands.some((c: string) => c.includes('notify --hook claude --account ci'))).toBe(true);
    expect(root.hooks.Stop).toHaveLength(2);
  });

  it('leaves a stranger\'s flat cursor entry untouched', () => {
    const target = join(dir, 'hooks.json');
    writeFileSync(
      target,
      JSON.stringify({
        version: 1,
        hooks: { stop: [{ command: 'acme notify --hook slack --account theirs' }] },
      }),
    );
    writeHostConfig('cursor', 'ci', io('hooks.json'));
    const root = JSON.parse(readFileSync(target, 'utf8'));
    expect(root.hooks.stop.map((h: { command: string }) => h.command)).toContain(
      'acme notify --hook slack --account theirs',
    );
    expect(root.hooks.stop).toHaveLength(2);
  });

  it('still adopts a hand-written tacendum hook instead of doubling it', () => {
    const target = join(dir, 'settings.json');
    writeFileSync(
      target,
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                { type: 'command', command: 'tacendum notify --hook claude --account old' },
              ],
            },
          ],
        },
      }),
    );
    writeHostConfig('claude-code', 'ci', io('settings.json'));
    const root = JSON.parse(readFileSync(target, 'utf8'));
    expect(root.hooks.Stop).toHaveLength(1);
    expect(JSON.stringify(root)).not.toContain('--account old');
  });

  it('refuses — never silently replaces — a foreign codex notify whose argv contains "notify"', () => {
    // The old TOML test matched `"notify", "--hook"` anywhere, so this line
    // was classified OURS and silently rewritten — disconnecting a notifier
    // the operator trusts, which is exactly what the refusal branch exists
    // to prevent.
    const target = join(dir, 'config.toml');
    const foreign = 'notify = ["acme", "notify", "--hook", "slack", "--account", "theirs"]\n';
    writeFileSync(target, foreign);
    expect(() => writeHostConfig('codex', 'ci', io('config.toml'))).toThrow(CliError);
    expect(readFileSync(target, 'utf8')).toBe(foreign);
  });
});

describe('the config write is atomic and keeps the host\'s permissions (F20)', () => {
  it('replaces the file by rename — the target is never truncated in place', () => {
    const target = join(dir, 'settings.json');
    writeFileSync(target, JSON.stringify({ model: 'opus' }));
    const before = statSync(target).ino;
    writeHostConfig('claude-code', 'ci', io('settings.json'));
    // A rename swaps in a NEW inode; an in-place `writeFileSync` truncates
    // and rewrites the same one — the difference is whether ENOSPC mid-write
    // leaves the host's config empty or leaves the old version intact.
    expect(statSync(target).ino).not.toBe(before);
    expect(JSON.parse(readFileSync(target, 'utf8')).model).toBe('opus');
  });

  it('keeps the existing file\'s mode, and creates fresh files 0644', () => {
    const target = join(dir, 'config.toml');
    writeFileSync(target, 'model = "gpt-5"\n');
    chmodSync(target, 0o600); // codex config can hold operator API keys
    writeHostConfig('codex', 'ci', io('config.toml'));
    expect(statSync(target).mode & 0o777).toBe(0o600);

    const fresh = writeHostConfig('claude-code', 'ci', io('settings.json'));
    expect(statSync(fresh.path).mode & 0o777).toBe(0o644);
  });
});

describe('the merge functions, driven directly', () => {
  // These four are what setup stands on; the direct calls document the wire
  // shapes so a change shows up as a diff here, not only inside a JSON blob.
  it('claude keeps its group shape; gemini gets its own, under its own event', () => {
    const claude = JSON.parse(mergeClaudeSettings(null, 'CMD e notify --hook claude --account ci'));
    const gemini = JSON.parse(mergeGeminiSettings(null, 'CMD e notify --hook gemini --account ci'));
    expect(claude.hooks.Stop[0].hooks[0]).toEqual({
      type: 'command',
      command: 'CMD e notify --hook claude --account ci',
      async: true,
      timeout: 10,
    });
    // Gemini: AfterAgent (its finished-turn event), ms timeout, no async.
    expect(gemini.hooks.AfterAgent[0].hooks[0]).toEqual({
      type: 'command',
      command: 'CMD e notify --hook gemini --account ci',
      timeout: 10_000,
    });
    expect(gemini.hooks.Stop).toBeUndefined();
    expect(gemini.hooks.Notification).toBeUndefined();
  });

  it('cursor entries are flat commands', () => {
    const root = JSON.parse(mergeCursorHooks(null, 'CMD notify --hook cursor'));
    expect(root.hooks.stop[0]).toEqual({ command: 'CMD notify --hook cursor' });
  });

  it('codex escapes TOML strings', () => {
    const line = codexNotifyLine(['/path/with "quote"/node', 'main.js']);
    expect(line).toContain('"/path/with \\"quote\\"/node"');
    expect(mergeCodexNotify(null, notifyArgv('codex', 'ci', '/tmp/e'))).toMatch(/^notify = \[/);
  });
});
