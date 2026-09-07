import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'tacendum-tomlkey-'));
process.env.TACENDUM_HOME = home;

const { saveProfile } = await import('../src/profile.js');
const { runMcpInstall, mergeJsonConfig, mergeTomlConfig, renderTomlSection } =
  await import('../src/mcp-install.js');
const { codexNotifyLine, mergeCodexNotify, notifyArgv } = await import('../src/hostconfig.js');
const { planFromCodexNotifyDispatchArgv } = await import('../src/codex-notify-dispatch.js');

const work = mkdtempSync(join(tmpdir(), 'tacendum-tomlkey-work-'));

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
const SPEC = { command: process.execPath, args: [entry, 'mcp', '--account', 'installer'] };
const SECTION = renderTomlSection(SPEC);

/**
 * GATE: TOML key identity is a property of the PARSED key
 * path, never of the header's bytes. `[mcp_servers."tacendum"]`,
 * `['mcp_servers'.'tacendum']`, `[ mcp_servers . tacendum ]` and
 * `["mcp_servers"."tacendum"]` all define the one table
 * `mcp_servers.tacendum`. A merger that compares header TEXT does not
 * recognise them, appends a second table for the same key, and the host's
 * config file — a file OTHER tools own — stops parsing. Same defect, other
 * merger: `"notify" = […]` is the same top-level key as `notify = […]` in
 * `mergeCodexNotify`.
 *
 * The counter below is deliberately test-local and text-level: it knows only
 * the spellings THIS FILE constructs plus the canonical one the installer
 * writes, so it cannot inherit a bug from the code under test.
 */
const KEY = String.raw`(?:mcp_servers|"mcp_servers"|'mcp_servers')`;
const SUB = String.raw`(?:tacendum|"tacendum"|'tacendum'|"\\u0074acendum")`;
const TARGET_HEADER = new RegExp(String.raw`^\s*\[\s*${KEY}\s*\.\s*${SUB}\s*\]\s*(?:#.*)?$`);

function targetHeaderCount(text: string): number {
  return text.split('\n').filter((l) => TARGET_HEADER.test(l)).length;
}

/** Every spelling TOML allows for the header of the SAME table. The bare
 * canonical spelling rides along as the control that must keep passing. */
const SPELLINGS = [
  '[mcp_servers.tacendum]', // control: the one spelling HEAD recognised
  '[mcp_servers."tacendum"]',
  '["mcp_servers".tacendum]',
  '["mcp_servers"."tacendum"]',
  "['mcp_servers'.'tacendum']",
  '[ mcp_servers . tacendum ]',
  '[mcp_servers.tacendum] # pinned by hand',
  '["mcp_servers"."\\u0074acendum"]', // t is 't': same key after unescaping
];

describe('mergeTomlConfig: quoted-equivalent spellings are the SAME key', () => {
  for (const spelling of SPELLINGS) {
    it(`recognises ${spelling} and replaces it instead of appending a duplicate`, () => {
      const existing = `${spelling}\ncommand = "/stale"\nargs = []\n\n[profile]\nname = "keep"\n`;
      const merged = mergeTomlConfig(existing, SECTION);
      // Replaced in place: the stale body is gone, the key exists ONCE, and
      // the operator's unrelated table survives byte-for-byte.
      expect(merged).not.toContain('/stale');
      expect(targetHeaderCount(merged)).toBe(1);
      expect(merged).toContain('[profile]\nname = "keep"');
    });
  }

  it('is idempotent from a quoted spelling: the second merge changes nothing', () => {
    const once = mergeTomlConfig('[mcp_servers."tacendum"]\ncommand = "/stale"\n', SECTION);
    expect(targetHeaderCount(once)).toBe(1);
    expect(mergeTomlConfig(once, SECTION)).toBe(once);
  });

  it('repairs the corruption the textual merge left behind: duplicate spellings collapse to one', () => {
    const corrupted = [
      '[mcp_servers."tacendum"]',
      'command = "/staleA"',
      '',
      '[mcp_servers.tacendum]',
      'command = "/staleB"',
      '',
      '[profile]',
      'name = "keep"',
      '',
    ].join('\n');
    const merged = mergeTomlConfig(corrupted, SECTION);
    expect(targetHeaderCount(merged)).toBe(1);
    expect(merged).not.toContain('/staleA');
    expect(merged).not.toContain('/staleB');
    expect(merged).toContain('name = "keep"');
  });

  it('a quoted key CONTAINING the dot — ["mcp_servers.tacendum"] — is a DIFFERENT key and must survive', () => {
    // One quoted key whose NAME contains a dot is not a path: this table is
    // `"mcp_servers.tacendum"`, not `mcp_servers.tacendum`. Appending ours
    // beside it is the correct merge, and their table must not be touched.
    const existing = '["mcp_servers.tacendum"]\nowner = "someone else"\n';
    const merged = mergeTomlConfig(existing, SECTION);
    expect(merged).toContain('["mcp_servers.tacendum"]\nowner = "someone else"');
    expect(targetHeaderCount(merged)).toBe(1);
  });
});

describe('mergeTomlConfig: the same key in non-table form cannot take a table — refuse, never corrupt', () => {
  it('an inline tacendum under [mcp_servers] is the same key', () => {
    const existing = '[mcp_servers]\ntacendum = { command = "/stale", args = [] }\n';
    expect(() => mergeTomlConfig(existing, SECTION)).toThrow(/refus/i);
  });

  it('a QUOTED inline "tacendum" under [mcp_servers] is the same key', () => {
    const existing = '[mcp_servers]\n"tacendum" = { command = "/stale", args = [] }\n';
    expect(() => mergeTomlConfig(existing, SECTION)).toThrow(/refus/i);
  });

  it('a top-level dotted mcp_servers.tacendum.command is the same key', () => {
    expect(() => mergeTomlConfig('mcp_servers.tacendum.command = "/stale"\n', SECTION)).toThrow(
      /refus/i,
    );
  });

  it('a top-level inline mcp_servers table cannot be extended by a header at all', () => {
    expect(() => mergeTomlConfig('mcp_servers = { other = {} }\n', SECTION)).toThrow(/refus/i);
  });

  it('an [[mcp_servers.tacendum]] array of tables cannot take our table', () => {
    const existing = '[[mcp_servers.tacendum]]\ncommand = "/stale"\n';
    expect(() => mergeTomlConfig(existing, SECTION)).toThrow(/refus/i);
  });
});

describe('mergeCodexNotify: quoted "notify" is the same top-level key', () => {
  const ARGV = notifyArgv('codex', 'ci', entry);

  it('a foreign notifier spelled "notify" is composed once under the same semantic key', () => {
    const existing = '"notify" = ["acme", "notify", "--hook", "slack", "--account", "theirs"]\n';
    const merged = mergeCodexNotify(existing, ARGV);
    const notifyLines = merged
      .split('\n')
      .filter((line) => /^\s*(?:notify|"notify"|'notify')\s*=/.test(line));
    expect(notifyLines).toHaveLength(1);
    const line = notifyLines[0] as string;
    const argv = JSON.parse(line.slice(line.indexOf('['), line.lastIndexOf(']') + 1)) as string[];
    expect(
      planFromCodexNotifyDispatchArgv(argv, { nodePath: ARGV[0]!, entryPath: ARGV[1]! }),
    ).toEqual({
      v: 1,
      account: 'ci',
      previous: [{ argv: ['acme', 'notify', '--hook', 'slack', '--account', 'theirs'] }],
    });
  });

  it("our own line spelled 'notify' is recognised and replaced in place", () => {
    const oldOurs = codexNotifyLine([
      ARGV[0]!,
      ARGV[1]!,
      'notify',
      '--hook',
      'codex',
      '--account',
      'old',
    ]);
    const existing = `${oldOurs.replace(/^notify/, "'notify'")}\n\n[profile]\nname = "keep"\n`;
    const merged = mergeCodexNotify(existing, ARGV);
    const notifyLines = merged
      .split('\n')
      .filter((l) => /^\s*(?:notify|"notify"|'notify')\s*=/.test(l));
    expect(notifyLines).toHaveLength(1);
    const line = notifyLines[0] as string;
    const argv = JSON.parse(line.slice(line.indexOf('['), line.lastIndexOf(']') + 1)) as string[];
    expect(
      planFromCodexNotifyDispatchArgv(argv, { nodePath: ARGV[0]!, entryPath: ARGV[1]! }),
    ).toEqual({
      v: 1,
      account: 'ci',
      previous: [],
    });
    expect(merged).not.toContain('--account old');
    expect(merged).toContain('name = "keep"');
  });

  it('a top-level dotted notify.* makes notify a table — refuse, our line would redefine it', () => {
    expect(() => mergeCodexNotify('notify.channel = "x"\n', ARGV)).toThrow(/refus/i);
  });
});

describe('the JSON path is identity-safe (checked, affirmatively)', () => {
  it('an escaped "\\u0074acendum" key normalises through JSON.parse and merges in place', () => {
    // JSON key identity is decided by the PARSED string: "tacendum"
    // parses to the property "tacendum", and assignment overwrites it. There
    // is no spelling of the same semantic key that survives JSON.parse as a
    // different property, so the JSON merger cannot have this defect.
    const existing = '{"mcpServers": {"\\u0074acendum": {"command": "/stale", "args": []}}}';
    const merged = JSON.parse(mergeJsonConfig(existing, SPEC)) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(merged.mcpServers)).toEqual(['tacendum']);
    expect(merged.mcpServers.tacendum).toEqual(SPEC);
  });
});

describe('--write leaves a parseable file with the key defined exactly once', () => {
  it('merging over a quoted-spelling section leaves ONE table on disk', () => {
    const target = join(work, 'config.toml');
    writeFileSync(target, '[mcp_servers."tacendum"]\ncommand = "/stale"\nargs = []\n');
    runMcpInstall(
      { host: 'codex', account: 'installer', write: true },
      { entryPath: entry, targetPath: target },
    );
    const onDisk = readFileSync(target, 'utf8');
    expect(onDisk).not.toContain('/stale');
    expect(targetHeaderCount(onDisk)).toBe(1);
  });
});
