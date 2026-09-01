import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * A SYNTACTICALLY VALID DOCUMENT THAT MEANS NOTHING IS NOT A STATE DUMP.
 *
 * `gate.failed-read-not-absence.test.ts` closed the case where the file does
 * not PARSE. `readGroupCallState` then cast whatever `JSON.parse` returned
 * straight to `GroupCallStateDump` with no validation, and `cmdGroupCallState`
 * refused only `null` — so replacing a client's `gcall-state.json` with `{}`
 * made `gcall` exit 0 and print `{}`.
 *
 * That is a false negative with a gate on the other end of it.
 * the e2e group-call harness asks whether carol's state names the session she was
 * not supposed to learn; it reads `gcall`'s status and then greps the dump for
 * the sid. Against `{}` the status is 0, the grep finds no sid, and 8h reports
 * success — over a document that says nothing about any session at all. The
 * same hole answers every other negative built on this command.
 *
 * A PARSE IS NOT A VALIDATION. The dump has one writer (`GroupSession.snapshot`
 * via `writeFileAtomic`) and it always writes the whole shape, so anything that
 * is not the whole shape did not come from this program — and a document this
 * program did not write is exactly the thing a negative assertion must not be
 * allowed to rest on.
 */

const home = mkdtempSync(join(tmpdir(), 'tacendum-gc3shape-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

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

function account(name: string): string {
  const dir = join(home, name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dir, 'profile.json'),
    JSON.stringify({
      name,
      identityKey: 'IDKEYMARKERBASE64==',
      userId: '01GC3SHAPE00000000000000A',
      authToken: 'Hp7Bn2QjRm4XcV9LkT6sWy1ZdF3gA8uE0oI5rNxxxxx',
      registrationId: 7,
      deviceId: 1,
    }),
    { mode: 0o600 },
  );
  return dir;
}

/** The shape `GroupSession.snapshot()` writes when it holds no session. */
const IDLE_DUMP = {
  live: false,
  sid: null,
  starterId: null,
  selfId: '01GC3SHAPE00000000000000A',
  roster: [] as string[],
  announced: [] as string[],
  se: 0,
  video: false,
  phase: null,
  legs: [] as unknown[],
  heldOffers: [] as string[],
  callKit: null,
  connected: false,
  endedReason: null,
};

describe('gcall refuses a dump that parses but is not a dump', () => {
  it('REFUSES an empty object — the falsifier the review handed in', async () => {
    const dir = account('shempty');
    writeFileSync(join(dir, 'gcall-state.json'), '{}');
    const r = await runCli(['gcall', 'shempty']);
    // THE ASSERTION: not exit 0, and not a printed `{}` an 8h-shaped check
    // would read as "no session".
    expect(r.code, 'a meaningless document was reported as a successful read').not.toBe(0);
    expect(r.stdout.trim()).toBe('');
    expect(r.stderr).toMatch(/could not be read/i);
  }, 120_000);

  it('REFUSES a JSON scalar, an array and a null literal', async () => {
    for (const [n, body] of [['shnum', '7'], ['sharr', '[]'], ['shnull', 'null']] as const) {
      const dir = account(n);
      writeFileSync(join(dir, 'gcall-state.json'), body);
      const r = await runCli(['gcall', n]);
      expect(r.code, `\`${body}\` was accepted as a session state dump`).not.toBe(0);
      expect(r.stdout.trim()).toBe('');
    }
  }, 240_000);

  it('REFUSES a dump missing a single load-bearing field', async () => {
    // `live` is the field every negative in the gate turns on. A document that
    // omits it cannot answer the question the command is asked.
    const dir = account('shpartial');
    const { live: _live, ...withoutLive } = IDLE_DUMP;
    writeFileSync(join(dir, 'gcall-state.json'), JSON.stringify(withoutLive));
    const r = await runCli(['gcall', 'shpartial']);
    expect(r.code, 'a dump with no `live` field was accepted').not.toBe(0);
  }, 120_000);

  it('REFUSES a dump whose field has the wrong TYPE', async () => {
    const dir = account('shtype');
    writeFileSync(join(dir, 'gcall-state.json'), JSON.stringify({ ...IDLE_DUMP, roster: 'nobody' }));
    const r = await runCli(['gcall', 'shtype']);
    expect(r.code, 'a dump whose roster is a string was accepted').not.toBe(0);
  }, 120_000);

  it('REFUSES a dump whose legs are not leg records', async () => {
    const dir = account('shleg');
    writeFileSync(
      join(dir, 'gcall-state.json'),
      JSON.stringify({ ...IDLE_DUMP, legs: [{ peerId: 1 }] }),
    );
    const r = await runCli(['gcall', 'shleg']);
    expect(r.code, 'a dump with a malformed leg was accepted').not.toBe(0);
  }, 120_000);

  // ---- and the honest run still passes ------------------------------------
  it('ACCEPTS the exact shape `snapshot()` writes, and prints it unchanged', async () => {
    const dir = account('shgood');
    writeFileSync(join(dir, 'gcall-state.json'), JSON.stringify(IDLE_DUMP));
    const r = await runCli(['gcall', 'shgood']);
    expect(r.code, `gcall stderr was:\n${r.stderr}`).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(IDLE_DUMP);
  }, 120_000);

  it('ACCEPTS a LIVE dump with a real leg', async () => {
    const dir = account('shlive');
    const live = {
      ...IDLE_DUMP,
      live: true,
      sid: '01SESSION0000000000000000',
      starterId: '01GC3SHAPE00000000000000A',
      roster: ['01GC3SHAPE00000000000000A', '01ARZ3NDEKTSV4RRFFQ69G5FAV'],
      announced: ['01GC3SHAPE00000000000000A'],
      se: 3,
      phase: 'active',
      connected: true,
      legs: [
        {
          peerId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
          cid: '01LEG00000000000000000000',
          phase: 'connected',
          direction: 'out',
          reoffersLeft: 2,
        },
      ],
    };
    writeFileSync(join(dir, 'gcall-state.json'), JSON.stringify(live));
    const r = await runCli(['gcall', 'shlive']);
    expect(r.code, `gcall stderr was:\n${r.stderr}`).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(live);
  }, 120_000);

  it('still answers never:true, successfully, when there is genuinely no file', async () => {
    account('shabsent');
    const r = await runCli(['gcall', 'shabsent']);
    expect(r.code, `gcall stderr was:\n${r.stderr}`).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ live: false, sid: null, never: true });
  }, 120_000);
});
