import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'tacendum-tomllex-'));
process.env.TACENDUM_HOME = home;

const { saveProfile } = await import('../src/profile.js');
const { runMcpInstall, mergeTomlConfig, renderTomlSection } = await import('../src/mcp-install.js');
const { codexNotifyLine, mergeCodexNotify, notifyArgv } = await import('../src/hostconfig.js');
const { scanTomlStructure, splitTomlLines } = await import('../src/toml-keys.js');

const work = mkdtempSync(join(tmpdir(), 'tacendum-tomllex-work-'));

saveProfile({
  name: 'installer',
  identityKey: 'IK==',
  userId: '01AGENTAGENTAGENTAGENTAGEN',
  authToken: 'tok',
  registrationId: 1,
  deviceId: 1,
});

const entry = join(work, 'main.js');
writeFileSync(entry, '#!/usr/bin/env node\n');
const SECTION = renderTomlSection({ command: process.execPath, args: [entry, 'mcp', '--account', 'installer'] });
const ARGV = notifyArgv('codex', 'ci', entry);

/** All-CRLF: every \n is preceded by \r, and no \r stands alone. */
function uniformlyCrlf(text: string): boolean {
  return /\r\n/.test(text) && !/(^|[^\r])\n/.test(text) && !/\r(?!\n)/.test(text);
}

/**
 * GATE: the TOML scanners are LINE-based, and two
 * kinds of line lied to them.
 *
 * Defect 1 — CRLF. Split on \n and every header keeps a trailing \r;
 * `[mcp_servers.tacendum]\r` parses as no header, so the merge appended a
 * SECOND table for a key the file already had — the duplicate-table
 * corruption the merge guard was written to prevent, back through another door. The
 * fix must also leave the file's OWN ending in place: rewriting a CRLF
 * config as LF is a whole-file diff in a file other tools own, and mixed
 * endings are worse.
 *
 * Defect 2 — multiline values. A """string""" or a reflowed array spans lines,
 * and a line INSIDE one that looks like `[mcp_servers.tacendum]` or
 * `notify = …` is content, not syntax. The scanners took it for syntax:
 * sections began inside strings (the replacement spliced the string's
 * middle and the next assignment OUT of the file), section ends landed
 * mid-array (the tail dangled after the fresh section), the codex insertion
 * point landed inside string content, and a foreign-looking `notify` inside
 * a docstring refused a valid file. All while reporting success.
 */
describe('defect 1: CRLF files — recognised, merged once, ending preserved', () => {
  it('replaces an existing CRLF section instead of appending a duplicate, and stays CRLF', () => {
    const existing = '[mcp_servers.tacendum]\r\ncommand = "/stale"\r\nargs = []\r\n';
    const merged = mergeTomlConfig(existing, SECTION);
    expect(merged.match(/\[mcp_servers\.tacendum\]/g)).toHaveLength(1);
    expect(merged).not.toContain('/stale');
    expect(uniformlyCrlf(merged)).toBe(true);
  });

  it('is byte-idempotent on a CRLF file', () => {
    const once = mergeTomlConfig('model = "o4"\r\n', SECTION);
    expect(uniformlyCrlf(once)).toBe(true);
    expect(mergeTomlConfig(once, SECTION)).toBe(once);
  });

  it('appends to a CRLF file in CRLF, untouched lines byte-identical', () => {
    const existing = '# mine\r\nmodel = "o4"\r\n';
    const merged = mergeTomlConfig(existing, SECTION);
    expect(merged.startsWith('# mine\r\nmodel = "o4"\r\n')).toBe(true);
    expect(uniformlyCrlf(merged)).toBe(true);
  });

  it('codex notify insertion into a CRLF config emits no mixed endings', () => {
    const existing = 'model = "gpt-5"\r\n\r\n[mcp_servers.foo]\r\ncommand = "x"\r\n';
    const merged = mergeCodexNotify(existing, ARGV);
    expect(uniformlyCrlf(merged)).toBe(true);
    expect(merged.indexOf('notify = [')).toBeLessThan(merged.indexOf('[mcp_servers.foo]'));
  });

  it('recognises our own CRLF notify line and replaces it in place', () => {
    const stale = codexNotifyLine(['/old', '/old-entry', 'notify', '--hook', 'codex', '--account', 'ci']);
    const merged = mergeCodexNotify(`${stale}\r\n`, ARGV);
    expect(merged.match(/notify = \[/g)).toHaveLength(1);
    expect(merged).not.toContain('/old-entry');
    expect(uniformlyCrlf(merged)).toBe(true);
  });

  it('--write on a CRLF codex config leaves ONE table on disk, still CRLF', () => {
    const target = join(work, 'crlf-config.toml');
    writeFileSync(target, '[mcp_servers.tacendum]\r\ncommand = "/stale"\r\n');
    runMcpInstall(
      { host: 'codex', account: 'installer', write: true },
      { entryPath: entry, targetPath: target },
    );
    const onDisk = readFileSync(target, 'utf8');
    expect(onDisk.match(/\[mcp_servers\.tacendum\]/g)).toHaveLength(1);
    expect(onDisk).not.toContain('/stale');
    expect(uniformlyCrlf(onDisk)).toBe(true);
  });

  it('refuses a file with MIXED endings rather than pick one', () => {
    const mixed = 'model = "o4"\r\nother = 1\n';
    expect(() => mergeTomlConfig(mixed, SECTION)).toThrow(/mixes line endings/);
    expect(() => mergeCodexNotify(mixed, ARGV)).toThrow(/mixes line endings/);
  });
});

describe('defect 2: multiline strings and arrays are content, never syntax', () => {
  it('a header-looking line inside a """string""" does not become a section — the string survives whole', () => {
    const existing = [
      '[mcp_servers.other]',
      'notes = """',
      '[mcp_servers.tacendum]',
      '"""',
      'command = "/bin/other"',
      '',
    ].join('\n');
    const merged = mergeTomlConfig(existing, SECTION);
    // The string's middle was NOT spliced out: closing quotes and the other
    // server's command line both survive, and ours was appended after.
    expect(merged).toContain('notes = """\n[mcp_servers.tacendum]\n"""');
    expect(merged).toContain('command = "/bin/other"');
    const at = merged.lastIndexOf('[mcp_servers.tacendum]');
    expect(at).toBeGreaterThan(merged.indexOf('command = "/bin/other"'));
    expect(mergeTomlConfig(merged, SECTION)).toBe(merged); // and it is stable
  });

  it("the same shape in a '''literal''' string also survives", () => {
    const existing = ["x = '''", '[mcp_servers.tacendum]', "'''", ''].join('\n');
    const merged = mergeTomlConfig(existing, SECTION);
    expect(merged).toContain("x = '''\n[mcp_servers.tacendum]\n'''");
    expect(merged.match(/\[mcp_servers\.tacendum\]/g)).toHaveLength(2); // the quoted prose + our real one
  });

  it('a section whose body holds a reflowed array is replaced WHOLE — no dangling tail', () => {
    const existing = [
      '[mcp_servers.tacendum]',
      'command = "/stale"',
      'env = [',
      '  ["A", "1"],',
      ']',
      '',
      '[profile]',
      'name = "keep"',
      '',
    ].join('\n');
    const merged = mergeTomlConfig(existing, SECTION);
    expect(merged).not.toContain('["A", "1"]'); // the stale body went with its section
    expect(merged).not.toContain('/stale');
    expect(merged).toContain('[profile]');
    expect(merged).toContain('name = "keep"');
    expect(merged.match(/\[mcp_servers\.tacendum\]/g)).toHaveLength(1);
  });

  it('the codex notify line is never inserted inside string content', () => {
    const existing = ['greeting = """', '[table_looking]', '"""', 'model = "x"', ''].join('\n');
    const merged = mergeCodexNotify(existing, ARGV);
    // The string is intact and our line sits OUTSIDE it, at top level.
    expect(merged).toContain('greeting = """\n[table_looking]\n"""');
    expect(merged.indexOf('notify = [')).toBeGreaterThan(merged.indexOf('"""\nmodel'));
  });

  it('a foreign-looking notify INSIDE a docstring is prose — merged past, not refused', () => {
    const existing = [
      'doc = """',
      'notify = ["acme", "notify", "--hook", "slack", "--account", "x"]',
      '"""',
      '',
    ].join('\n');
    const merged = mergeCodexNotify(existing, ARGV); // used to throw "another notifier"
    expect(merged).toContain('doc = """');
    expect(merged).toContain('"--account", "ci"');
  });

  it("our own notify reflowed across lines is replaced with its WHOLE extent", () => {
    const existing = [
      'notify = ["/n", "/e", "notify", "--hook", "codex", "--account",',
      '  "ci"]',
      '',
    ].join('\n');
    const merged = mergeCodexNotify(existing, ARGV);
    expect(merged).not.toContain('  "ci"]'); // the old value's tail went with it
    expect(merged.match(/notify = \[/g)).toHaveLength(1);
  });

  it('refuses a file that ends inside an unterminated multiline value — there is no top level to append to', () => {
    expect(() => mergeTomlConfig('x = """\nnever closed\n', SECTION)).toThrow(/unterminated/);
    expect(() => mergeCodexNotify('x = [\n  "never closed",\n', ARGV)).toThrow(/unterminated/);
  });

  it('escapes do not fool the lexer: \\" does not close, and # inside a string is not a comment', () => {
    // value = "a\"b" — the escaped quote must not end the string early
    // (which would make the trailing text syntax); the # inside the string
    // opens no comment that could swallow a real delimiter.
    const existing = 'x = "a\\"# not a comment [mcp_servers.tacendum]"\ny = 1\n';
    const merged = mergeTomlConfig(existing, SECTION);
    expect(merged.startsWith('x = "a\\"# not a comment [mcp_servers.tacendum]"\ny = 1\n')).toBe(true);
    expect(merged.match(/^\[mcp_servers\.tacendum\]$/m)).toHaveLength(1);
  });
});

describe('the lexer itself (scanTomlStructure / splitTomlLines)', () => {
  it('maps continuation lines as non-structural and closes correctly', () => {
    const lines = [
      'a = """',
      '[not.a.header]',
      '"""',
      'b = [',
      '  [1, 2],',
      ']',
      '[real]',
      'c = 1',
    ];
    const scan = scanTomlStructure(lines);
    expect(scan.structural).toEqual([true, false, false, true, false, false, true, true]);
    expect(scan.openAtEof).toBe(false);
    expect(scan.malformedAt).toBeNull();
  });

  it('flags an unterminated single-line string as malformed instead of guessing', () => {
    const scan = scanTomlStructure(['x = "never closed', 'y = 1']);
    expect(scan.malformedAt).toBe(0);
  });

  it('splitTomlLines: LF, CRLF, and mixed', () => {
    expect(splitTomlLines('a\nb\n')).toEqual({ lines: ['a', 'b', ''], eol: '\n' });
    expect(splitTomlLines('a\r\nb\r\n')).toEqual({ lines: ['a', 'b', ''], eol: '\r\n' });
    expect(splitTomlLines('a\r\nb\n')).toBeNull();
    expect(splitTomlLines('a\rb\n')).toBeNull();
  });
});
