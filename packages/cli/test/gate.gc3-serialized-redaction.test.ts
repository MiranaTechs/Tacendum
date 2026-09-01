import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

/**
 * A DOCUMENT THAT IS JSON MUST NEVER BE REDACTED AS A STRING, AND REDACTING A
 * KEY MUST NEVER DELETE A FIELD.
 *
 * `gate.value-redaction.test.ts` established the first half for the `--json`
 * arm and for the two printers that had already moved to `emitRecord`
 * (`calllog`, `gcall`). It left two holes, and the review found both.
 *
 *   (a) `cmdWhoami` still called `emit(record, JSON.stringify(record, null, 2))`.
 *       `emit`'s HUMAN arm is `redactCredentials(human)` — a pass over the
 *       SERIALIZED document, which is precisely the shape the other file exists
 *       to forbid. The server chooses the token (`AuthResponse.authToken` is a
 *       plain `z.string()`), so it chooses where the run lands:
 *         - a valid base64url token opening `identity` renames the field,
 *           `"identityKey"` -> `"[credential withheld]Key"`;
 *         - a token opening `"identity` eats the OPENING QUOTE and `whoami`
 *           prints something no parser accepts. `MSG=$(tacendum whoami ci-bot)`
 *           is the documented shape (output.ts rule 1); a hostile server could
 *           break it at will.
 *
 *   (b) `redactValue` assigned redacted KEYS into a plain object. Two distinct
 *       keys can redact to the SAME marker, and the second assignment silently
 *       overwrote the first: with the 43-character token
 *       `announcedconnected`+25, the dump `{live,announced,connected}` came out
 *       with TWO fields, not three. A redaction that deletes a field is a
 *       corruption of the record, and `gcall`'s dump is what the e2e gate reads
 *       to decide whether a session exists.
 *
 * Both are pinned here by COUNTING and by PARSING, never by string comparison:
 * "the output still looks about right" is what let (a) ship.
 */

const home = mkdtempSync(join(tmpdir(), 'tacendum-gc3redact-'));
process.env.TACENDUM_HOME = home;

const { Reporter } = await import('../src/output.js');
const { forgetCredentials, guardCredential, redactValues } = await import('../src/render.js');

afterAll(() => rmSync(home, { recursive: true, force: true }));

/**
 * A 43-character token in the shape the server mints, whose first characters
 * are the literal text `"identity` — the opening quote of `"identityKey"` plus
 * the field name. `authToken` is a plain `z.string()`, so nothing here is
 * malformed; the server simply picks this value.
 */
const QUOTE_TOKEN = '"identityXv1TbN7wLpD4hJ2msY6ceA0uGfWi5oQxE9';

/** The same collision without the quote: base64url-clean, renames the field. */
const FIELD_TOKEN = 'identityXv1TbN7wLpD4hJ2msY6ceA0uGfWi5oQxE9r';

/** A token that redacts BOTH `announced` and `connected` to the same marker. */
const COLLIDING_KEYS_TOKEN = 'announcedconnectedXv1TbN7wLpD4hJ2msY6ceA0uG';

/** Capture one Reporter write without a terminal. */
function captured(fn: () => void): string {
  let out = '';
  const original = process.stdout.write.bind(process.stdout);
  // @ts-expect-error — narrowing the overload set is the point of the stub.
  process.stdout.write = (chunk: string): boolean => {
    out += chunk;
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = original;
  }
  return out;
}

describe('redacting a key never deletes a field', () => {
  afterEach(() => forgetCredentials());

  it('keeps BOTH fields when two keys redact to the same marker (field count)', () => {
    guardCredential(COLLIDING_KEYS_TOKEN);
    const dump = { live: true, announced: ['peer'], connected: false };
    const out = redactValues(dump) as Record<string, unknown>;
    // THE ASSERTION THAT FAILED: three in, two out — `announced` vanished.
    expect(Object.keys(out)).toHaveLength(Object.keys(dump).length);
    // …and both VALUES are still there, under whatever names they now carry.
    const values = Object.values(out);
    expect(values).toContainEqual(['peer']);
    expect(values).toContainEqual(false);
    expect(values).toContainEqual(true);
    // …and the document still serializes.
    expect(() => JSON.parse(JSON.stringify(out))).not.toThrow();
  });

  it('keeps every field when THREE keys collapse onto one marker', () => {
    // Three-way collision: nothing may be lost however many keys collide.
    guardCredential('announcedconnectedcallkitXv1TbN7wLpD4hJ2ms');
    const dump = { live: true, announced: [], connected: false, callkit: 'x' };
    const out = redactValues(dump) as Record<string, unknown>;
    expect(Object.keys(out)).toHaveLength(4);
    expect(new Set(Object.keys(out)).size).toBe(4);
  });

  it('still redacts a credential that IS a key', () => {
    // The reason keys are walked at all: a record may be KEYED by a value the
    // server chose. Non-destructive must not mean non-redacting.
    guardCredential(FIELD_TOKEN);
    const out = redactValues({ [FIELD_TOKEN]: 1, other: 2 }) as Record<string, unknown>;
    expect(Object.keys(out)).toHaveLength(2);
    expect(JSON.stringify(out)).not.toContain(FIELD_TOKEN.slice(0, 8));
  });
});

describe('a printer whose human form is a JSON document', () => {
  afterEach(() => forgetCredentials());

  it('emitRecord pretty-prints on the human arm and stays parseable', () => {
    guardCredential(QUOTE_TOKEN);
    const report = new Reporter({ json: false, plain: true });
    const out = captured(() => report.emitRecord({ name: 'ci-bot', identityKey: 'K' }, { pretty: true }));
    expect(out).toContain('\n  ');
    expect(Object.keys(JSON.parse(out) as object)).toHaveLength(2);
  });

  it('emitRecord stays COMPACT under --json, whatever pretty says', () => {
    const report = new Reporter({ json: true, plain: true });
    const out = captured(() => report.emitRecord({ a: 1, b: 2 }, { pretty: true }));
    expect(out).toBe('{"a":1,"b":2}\n');
  });
});

/**
 * THE SAME PROPERTY THROUGH THE REAL BINARY, on the command an operator
 * scripts and a hook forwards. The token comes off disk — `loadProfile`
 * registers it at the chokepoint — so nothing is staged inside the process
 * under test.
 */
describe('whoami through the real binary', () => {
  const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

  function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'packages/cli/src/main.ts', ...args], {
        cwd: repoRoot,
        env: { ...process.env, TACENDUM_HOME: home, NODE_USE_SYSTEM_CA: '0' },
      });
      child.stdin.end();
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
  }

  function account(name: string, authToken: string): void {
    const dir = join(home, name);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(dir, 'profile.json'),
      JSON.stringify({
        name,
        identityKey: 'IDKEYMARKERBASE64==',
        userId: '01GC3REDACT0000000000000A',
        authToken,
        registrationId: 7,
        deviceId: 1,
      }),
      { mode: 0o600 },
    );
  }

  it('prints PARSEABLE JSON when the token opens with a quote and a field name', async () => {
    account('wquote', QUOTE_TOKEN);
    const r = await runCli(['whoami', 'wquote']);
    expect(r.code, `whoami stderr was:\n${r.stderr}`).toBe(0);
    // THE FALSIFIER'S OWN ASSERTION: `humanWhoamiParseable`.
    const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
    // …and NOT VACUOUS: every field the record carries is still a field.
    expect(Object.keys(parsed)).toHaveLength(4);
    expect(parsed.name).toBe('wquote');
    expect(parsed.userId).toBe('01GC3REDACT0000000000000A');
    expect(`${r.stdout}${r.stderr}`).not.toContain(QUOTE_TOKEN.slice(0, 8));
  }, 120_000);

  it('prints PARSEABLE JSON when the token collides with the identityKey field name', async () => {
    account('wfield', FIELD_TOKEN);
    const r = await runCli(['whoami', 'wfield']);
    expect(r.code, `whoami stderr was:\n${r.stderr}`).toBe(0);
    const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(Object.keys(parsed)).toHaveLength(4);
    // The key is redacted — that is the point of walking keys — but the value
    // it carried is still in the document, and the document still parses.
    expect(Object.values(parsed)).toContain('IDKEYMARKERBASE64==');
  }, 120_000);

  it('--json is unchanged for a healthy profile (byte-identical contract)', async () => {
    account('whealthy', 'Hp7Bn2QjRm4XcV9LkT6sWy1ZdF3gA8uE0oI5rNxxxxx');
    const r = await runCli(['whoami', 'whealthy', '--json']);
    expect(r.code, `whoami stderr was:\n${r.stderr}`).toBe(0);
    expect(r.stdout).toBe(
      '{"name":"whealthy","userId":"01GC3REDACT0000000000000A","class":"human"}\n',
    );
  }, 120_000);

  it('the human arm of a healthy profile is still pretty two-space JSON', async () => {
    const r = await runCli(['whoami', 'whealthy']);
    expect(r.code, `whoami stderr was:\n${r.stderr}`).toBe(0);
    expect(r.stdout).toBe(
      `${JSON.stringify(
        {
          name: 'whealthy',
          userId: '01GC3REDACT0000000000000A',
          class: 'human',
          identityKey: 'IDKEYMARKERBASE64==',
        },
        null,
        2,
      )}\n`,
    );
  }, 120_000);
});
