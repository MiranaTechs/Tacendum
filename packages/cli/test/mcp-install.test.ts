import { describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'tacendum-mcpinstall-'));
process.env.TACENDUM_HOME = home;

const { saveProfile } = await import('../src/profile.js');
const {
  runMcpInstall,
  mergeJsonConfig,
  mergeTomlConfig,
  renderTomlSection,
  configPathFor,
  builtEntryPath,
} = await import('../src/mcp-install.js');

const work = mkdtempSync(join(tmpdir(), 'tacendum-mcpinstall-work-'));

// A registered account for the --write path, which refuses to install a
// config the server itself would refuse to start.
saveProfile({
  name: 'installer',
  identityKey: 'IK==',
  userId: '01AGENTAGENTAGENTAGENTAGEN',
  authToken: 'tok',
  registrationId: 1,
  deviceId: 1,
});

// A stand-in for the built artifact: --write refuses a missing entry, and
// these tests are about merging, not about esbuild.
const entry = join(work, 'main.js');
writeFileSync(entry, '#!/usr/bin/env node\n');

const SPEC = { command: process.execPath, args: [entry, 'mcp', '--account', 'installer'] };

/**
 * the design plan: config generated, not documented; merged, not clobbered.
 * The failure the merge tests guard is concrete: these files hold OTHER
 * tools' settings, and "my other three MCP servers vanished" is the bug an
 * install command must make impossible.
 */
describe('mcp install argument handling', () => {
  it('refuses a missing or unknown host with usage', () => {
    expect(() => runMcpInstall({ host: undefined, account: undefined, write: false })).toThrow(/usage:/);
    expect(() => runMcpInstall({ host: 'cursor', account: undefined, write: false })).toThrow(/usage:/);
  });

  it('refuses --write without an account — a config without one cannot work', () => {
    expect(() =>
      runMcpInstall({ host: 'codex', account: undefined, write: true }, { entryPath: entry, targetPath: join(work, 'never.toml') }),
    ).toThrow(/--write needs --account/);
  });

  it('refuses --write for an unregistered account, with the register remedy', () => {
    expect(() =>
      runMcpInstall({ host: 'codex', account: 'ghost', write: true }, { entryPath: entry, targetPath: join(work, 'never.toml') }),
    ).toThrow(/no such account/);
  });

  it('refuses --write when the built artifact does not exist, naming the build command', () => {
    expect(() =>
      runMcpInstall(
        { host: 'codex', account: 'installer', write: true },
        { entryPath: join(work, 'not-built.js'), targetPath: join(work, 'never.toml') },
      ),
    ).toThrow(/build it first/);
  });

  it('knows the three hosts\' config locations', () => {
    expect(configPathFor('claude-desktop')).toContain(join('Claude', 'claude_desktop_config.json'));
    expect(configPathFor('claude-code')).toBe(join(process.cwd(), '.mcp.json'));
    expect(configPathFor('codex')).toContain(join('.codex', 'config.toml'));
    // The artifact resolves from the MODULE's location, never the cwd a host
    // happened to launch from.
    expect(builtEntryPath()).toContain(join('packages', 'cli', 'dist', 'main.js'));
  });
});

describe('the printed block', () => {
  it('states the true capability: no send, no network — and acknowledge purges', () => {
    for (const host of ['claude-desktop', 'claude-code', 'codex'] as const) {
      const printed = runMcpInstall(
        { host, account: 'installer', write: false },
        { entryPath: entry, targetPath: join(work, 'ignored') },
      );
      // "read-only" was a false claim: tacendum_acknowledge_messages marks
      // messages read, which starts the retention clock that purges those
      // bodies from local disk. The config block is where the next person
      // meets this server, so it must say that, not the reassuring version.
      expect(printed).not.toMatch(/read.only/i);
      expect(printed).toContain('purge');
      expect(printed).toContain('no send capability');
    }
  });

  it('prints a JSON block for the Claude hosts that parses to the exact server entry', () => {
    const printed = runMcpInstall(
      { host: 'claude-desktop', account: 'installer', write: false },
      { entryPath: entry, targetPath: join(work, 'ignored') },
    );
    // Comment lines ride above the block; the block itself must be pure JSON.
    const json = printed.split('\n').filter((l) => !l.startsWith('//')).join('\n');
    const parsed = JSON.parse(json);
    expect(parsed.mcpServers.tacendum).toEqual(SPEC);
    // The interpreter is absolute: a host launched outside the user's shell
    // has a PATH that has never seen nvm, and a bare "node" dies silently.
    expect(parsed.mcpServers.tacendum.command.startsWith('/')).toBe(true);
  });

  it('prints a [mcp_servers.tacendum] section for codex', () => {
    const printed = runMcpInstall(
      { host: 'codex', account: 'installer', write: false },
      { entryPath: entry, targetPath: join(work, 'ignored') },
    );
    expect(printed).toContain('[mcp_servers.tacendum]');
    expect(printed).toContain(`command = "${process.execPath}"`);
    expect(printed).toContain('"--account", "installer"');
  });
});

describe('mergeJsonConfig', () => {
  it('preserves every unrelated key and every other MCP server', () => {
    const existing = JSON.stringify({
      theme: 'dark',
      mcpServers: {
        othertool: { command: '/usr/bin/other', args: ['x'] },
        tacendum: { command: '/stale/node', args: ['old'] },
      },
    });
    const merged = JSON.parse(mergeJsonConfig(existing, SPEC));
    expect(merged.theme).toBe('dark');
    expect(merged.mcpServers.othertool).toEqual({ command: '/usr/bin/other', args: ['x'] });
    expect(merged.mcpServers.tacendum).toEqual(SPEC); // replaced, not duplicated
  });

  it('starts from an empty object when there is no config yet', () => {
    expect(JSON.parse(mergeJsonConfig(null, SPEC)).mcpServers.tacendum).toEqual(SPEC);
    expect(JSON.parse(mergeJsonConfig('', SPEC)).mcpServers.tacendum).toEqual(SPEC);
  });

  it('refuses a file it cannot parse instead of guessing', () => {
    expect(() => mergeJsonConfig('{ not json', SPEC)).toThrow(/refusing to guess/);
    expect(() => mergeJsonConfig('[1,2,3]', SPEC)).toThrow(/refusing to overwrite/);
  });
});

describe('mergeTomlConfig', () => {
  const section = renderTomlSection(SPEC);

  it('appends to a config that has no tacendum section, leaving the rest byte-identical', () => {
    const existing = '# my settings\nmodel = "o4"\n\n[mcp_servers.other]\ncommand = "/bin/other"\n';
    const merged = mergeTomlConfig(existing, section);
    expect(merged.startsWith('# my settings\nmodel = "o4"')).toBe(true);
    expect(merged).toContain('[mcp_servers.other]');
    expect(merged).toContain('[mcp_servers.tacendum]');
  });

  it('replaces its own section on a re-run instead of appending a second one', () => {
    const once = mergeTomlConfig('[mcp_servers.other]\ncommand = "/bin/other"\n', section);
    const twice = mergeTomlConfig(once, section);
    expect(twice.match(/\[mcp_servers\.tacendum\]/g)?.length).toBe(1);
    // Idempotent to the byte: the comment lives INSIDE the section, so the
    // replace swallows its own previous output whole.
    expect(twice).toBe(once);
    expect(twice).toContain('[mcp_servers.other]');
  });

  it('replaces a stale section that sits BETWEEN other tables', () => {
    const existing = [
      '[mcp_servers.tacendum]',
      'command = "/stale"',
      '',
      '[profile]',
      'name = "keep me"',
      '',
    ].join('\n');
    const merged = mergeTomlConfig(existing, section);
    expect(merged).not.toContain('/stale');
    expect(merged).toContain('name = "keep me"');
    expect(merged.match(/\[mcp_servers\.tacendum\]/g)?.length).toBe(1);
  });
});

describe('--write against a real file', () => {
  it('backs up first, merges, and leaves unrelated keys standing', () => {
    const target = join(work, '.mcp.json');
    writeFileSync(
      target,
      JSON.stringify({ mcpServers: { other: { command: '/bin/other', args: [] } }, unrelated: 1 }),
    );
    runMcpInstall(
      { host: 'claude-code', account: 'installer', write: true },
      { entryPath: entry, targetPath: target },
    );
    const written = JSON.parse(readFileSync(target, 'utf8'));
    expect(written.unrelated).toBe(1);
    expect(written.mcpServers.other.command).toBe('/bin/other');
    expect(written.mcpServers.tacendum).toEqual(SPEC);
    // The ONE rolling backup holds the pre-merge bytes (timestamped
    // accumulation was multiplying other servers' secrets on disk).
    const backups = readdirSync(work).filter((f) => f.startsWith('.mcp.json.bak'));
    expect(backups).toEqual(['.mcp.json.bak']);
    const backup = JSON.parse(readFileSync(join(work, '.mcp.json.bak'), 'utf8'));
    expect(backup.mcpServers.tacendum).toBeUndefined();
  });

  it('creates a fresh file (no backup) when none exists', () => {
    const target = join(work, 'fresh', '.mcp.json');
    runMcpInstall(
      { host: 'claude-code', account: 'installer', write: true },
      { entryPath: entry, targetPath: target },
    );
    expect(JSON.parse(readFileSync(target, 'utf8')).mcpServers.tacendum).toEqual(SPEC);
    expect(readdirSync(join(work, 'fresh')).filter((f) => f.includes('.bak')).length).toBe(0);
  });

  it('refuses a symlinked target instead of following it out of the project', () => {
    // `.mcp.json` for claude-code is resolved from the CWD — a hostile
    // checkout can plant a symlink there, and following it would back the
    // linked-to file's content up INTO the project (disclosure) and then
    // clobber the linked-to file (a write outside the project).
    const dir = mkdtempSync(join(tmpdir(), 'tacendum-mcpinstall-link-'));
    const outsideBytes = JSON.stringify({ mcpServers: { victim: { command: '/bin/v', args: [] } } });
    const outside = join(dir, 'outside.json');
    writeFileSync(outside, outsideBytes);
    const target = join(dir, '.mcp.json');
    symlinkSync(outside, target);
    expect(() =>
      runMcpInstall(
        { host: 'claude-code', account: 'installer', write: true },
        { entryPath: entry, targetPath: target },
      ),
    ).toThrow(/symbolic link/);
    expect(readFileSync(outside, 'utf8')).toBe(outsideBytes); // untouched
    expect(readdirSync(dir).filter((f) => f.includes('.bak')).length).toBe(0);
  });

  it('refuses a dangling symlink — a plain write would create the file it points at', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tacendum-mcpinstall-dangle-'));
    const target = join(dir, '.mcp.json');
    symlinkSync(join(dir, 'nowhere.json'), target);
    expect(() =>
      runMcpInstall(
        { host: 'claude-code', account: 'installer', write: true },
        { entryPath: entry, targetPath: target },
      ),
    ).toThrow(/symbolic link/);
    expect(existsSync(join(dir, 'nowhere.json'))).toBe(false);
  });

  it('re-running an identical install writes no second backup and does not rewrite', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tacendum-mcpinstall-idem-'));
    const target = join(dir, '.mcp.json');
    runMcpInstall(
      { host: 'claude-code', account: 'installer', write: true },
      { entryPath: entry, targetPath: target },
    );
    const bytes = readFileSync(target, 'utf8');
    runMcpInstall(
      { host: 'claude-code', account: 'installer', write: true },
      { entryPath: entry, targetPath: target },
    );
    expect(readFileSync(target, 'utf8')).toBe(bytes);
    // The first run created the file (no backup); the identical re-run must
    // not litter one either.
    expect(readdirSync(dir).filter((f) => f.includes('.bak')).length).toBe(0);
  });

  it('replaces the file atomically — a write-protected target is replaced, mode preserved', () => {
    // The observable difference between truncate-in-place and same-directory
    // temp + rename: rename needs no write permission on the target, and the
    // reader never sees a half-written file.
    const dir = mkdtempSync(join(tmpdir(), 'tacendum-mcpinstall-atomic-'));
    const target = join(dir, '.mcp.json');
    writeFileSync(target, JSON.stringify({ mcpServers: { other: { command: '/bin/o', args: [] } } }));
    chmodSync(target, 0o444);
    runMcpInstall(
      { host: 'claude-code', account: 'installer', write: true },
      { entryPath: entry, targetPath: target },
    );
    const written = JSON.parse(readFileSync(target, 'utf8'));
    expect(written.mcpServers.tacendum).toEqual(SPEC);
    expect(written.mcpServers.other.command).toBe('/bin/o');
    expect(statSync(target).mode & 0o777).toBe(0o444);
  });

  it('touches nothing — not even a backup — when the existing file is refused', () => {
    const target = join(work, 'broken.json');
    writeFileSync(target, '{ definitely not json');
    expect(() =>
      runMcpInstall(
        { host: 'claude-code', account: 'installer', write: true },
        { entryPath: entry, targetPath: target },
      ),
    ).toThrow(/refusing to guess/);
    expect(readFileSync(target, 'utf8')).toBe('{ definitely not json');
    expect(readdirSync(work).filter((f) => f.startsWith('broken.json.bak')).length).toBe(0);
  });
});
