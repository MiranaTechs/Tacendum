import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * A FAILED READ IS A FAILED CHECK — NEVER EVIDENCE OF ABSENCE.
 *
 * The rule already governs two places: the e2e call harness and the e2e group-call harness
 * 8g both refuse to compare two `calllog` counts unless both reads succeeded,
 * because `wc` is perfectly happy with no input and two DEAD readers agree.
 *
 * `gcall` broke it one layer down, in the CLI itself. `readGroupCallState`
 * answers `null` for a state file that does not exist AND for one that does not
 * parse (group-call.ts), and `cmdGroupCallState` turned that single `null` into
 * a POSITIVE, SUCCESSFUL record: `{"live":false,"sid":null,"never":true}`, exit
 * 0. So a truncated, half-restored or vandalised dump was reported as a client
 * that had never held a session — and the e2e group-call harness, whose whole
 * question is "does carol's state name the session she was not supposed to
 * learn", got "no" from a file nobody had read.
 *
 * `never: true` is a claim. This pins that it is only made when there is
 * genuinely nothing on disk, and that the unreadable case is loud instead.
 */

const home = mkdtempSync(join(tmpdir(), 'tacendum-failedread-'));
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
      userId: '01FAILEDREAD00000000000000',
      authToken: 'Hp7Bn2QjRm4XcV9LkT6sWy1ZdF3gA8uE0oI5rNxxxxx',
      registrationId: 7,
      deviceId: 1,
    }),
    { mode: 0o600 },
  );
  return dir;
}

describe('gcall distinguishes "no session" from "I could not read"', () => {
  it('answers never:true, successfully, when there is genuinely no state file', async () => {
    account('frnostate');
    const r = await runCli(['gcall', 'frnostate']);
    expect(r.code, `gcall stderr was:\n${r.stderr}`).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ live: false, sid: null, never: true });
  }, 120_000);

  it('REFUSES when the state file exists and does not parse', async () => {
    const dir = account('frbadstate');
    // A half-written or vandalised dump. `writeFileAtomic` means this cannot
    // happen from a torn write of our own — which is exactly why it appearing
    // is worth refusing over rather than papering into a negative answer.
    writeFileSync(join(dir, 'gcall-state.json'), '{"live":true,"sid":"01SESSION0000');

    const r = await runCli(['gcall', 'frbadstate']);
    // THE ASSERTION: not exit 0, and not the positive record.
    expect(r.code, 'an unreadable state file was reported as a successful read').not.toBe(0);
    expect(r.stdout, 'a "never held a session" claim was made about a file nobody read').not.toContain(
      'never',
    );
    expect(r.stderr).toMatch(/could not be read/i);
    // NOT VACUOUS: the refusal says what to do about it.
    expect(r.stderr).toMatch(/gcall-state\.json/);
  }, 120_000);

  it('a session that IS readable is still reported exactly', async () => {
    const dir = account('frgoodstate');
    // THE WHOLE SHAPE `snapshot()` WRITES. It used to be four fields here, and
    // that passed only because `readGroupCallState` cast without checking — the
    // hole `gate.gc3-state-shape.test.ts` closes. A fixture that could not have
    // come off a real client is not a fixture for "a readable session".
    const dump = {
      live: true,
      sid: '01SESSION0000000000000000',
      starterId: '01FAILEDREAD00000000000000',
      selfId: '01FAILEDREAD00000000000000',
      roster: [] as string[],
      announced: [] as string[],
      se: 0,
      video: false,
      phase: 'active',
      legs: [] as unknown[],
      heldOffers: [] as string[],
      callKit: null,
      connected: false,
      endedReason: null,
    };
    writeFileSync(join(dir, 'gcall-state.json'), JSON.stringify(dump));
    const r = await runCli(['gcall', 'frgoodstate']);
    expect(r.code, `gcall stderr was:\n${r.stderr}`).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(dump);
  }, 120_000);
});
