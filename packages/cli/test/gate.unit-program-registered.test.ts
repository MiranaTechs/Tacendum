import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { SERVICE_VARIANTS, installHintFor, programArgs } from '../src/service.js';
import { EXIT } from '../src/exit.js';

/**
 * EVERY UNIT'S PROGRAM WORD MUST BE A COMMAND THE BINARY REGISTERS.
 *
 * `cmdService install` writes a launchd plist / systemd unit whose program is
 * `node main.js <programArgs(account, variant)>`, sets KeepAlive, and walks
 * away. If element 0 of that argv is a word main.ts's dispatch does not know,
 * the program prints HELP to stderr and exits EXIT.USAGE — instantly — and
 * the supervisor restarts it forever at the 60-second throttle floor. Nothing
 * tells the operator why: launchd has no opinion about exit 9, the unit file
 * looks perfect, and `service status` even reports it "installed".
 *
 * That is not a hypothetical. Verified against HEAD before this gate's fix:
 * main.ts contained ZERO occurrences of the string 'review-peer', while
 * service.ts shipped the 'review-peer' variant and `review-peer.ts` shipped
 * the responder — so `tacendum review-peer service install` (had anything
 * been able to reach it) would have installed exactly that crash-loop. The
 * registration and the variant landed in different sessions (service.ts
 * records why), and no test connected them.
 *
 * THE GATE ASKS THE REAL BINARY, not the source: it enumerates the runtime
 * `SERVICE_VARIANTS`, computes each variant's program word the same way the
 * unit renderer does, and requires `tacendum <word> --help` to exit with
 * anything but EXIT.USAGE. `--help` is the one invocation every registered
 * command answers without an account, a network, or a config — and the one an
 * unregistered word cannot answer, because the unknown-command arm is what
 * throws USAGE. A variant added to service.ts without a main.ts case goes
 * red here, named, before anyone installs it.
 */

const home = mkdtempSync(join(tmpdir(), 'tacendum-unit-registered-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'packages/cli/src/main.ts', ...args],
      {
        cwd: repoRoot,
        env: { ...process.env, TACENDUM_HOME: home, NODE_USE_SYSTEM_CA: '0' },
      },
    );
    child.stdin.end();
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

describe('every ServiceVariant names a program main.ts registers', () => {
  for (const variant of SERVICE_VARIANTS) {
    const word = programArgs('acct', variant)[0] as string;
    it(`the ${variant} unit's program word (${word}) answers --help, not EXIT.USAGE`, async () => {
      const { code, stdout } = await runCli([word, '--help']);
      expect(
        code,
        `\`tacendum ${word} --help\` exited ${code} — the ${variant} unit's program is not a ` +
          'registered command, so its installed unit crash-loops at the throttle floor',
      ).not.toBe(EXIT.USAGE);
      // The affirmative half: --help means the HELP text, on stdout. Without
      // this, a registered word that hangs or dies some new way could still
      // slip past the single not-9 assertion.
      expect(code).toBe(EXIT.OK);
      expect(stdout).toContain('usage:');
    });
  }
});

/**
 * THE SAME LAW FOR THE OTHER DIRECTION: a command the CLI quotes AT the
 * operator must be as real as the one it runs FOR them. `cmdService status`
 * answers "nothing installed" with a hint, and the calls variant's hint named
 * `tacendum calls service install <account>` — a command main.ts has never
 * registered (nothing dispatches `cmdService` with 'calls' at all), so the
 * one operator who followed the CLI's own advice got HELP and exit 9. The
 * program-word gate above could not see it: the calls UNIT runs `listen`,
 * which answers fine; it was the prose that lied.
 *
 * Same probe as above, aimed at the hint: every variant's hint must quote a
 * `tacendum <word>` whose word the binary answers. The word, not the full
 * line, deliberately — running a hint verbatim would need a registered
 * account (an unregistered one exits USAGE by design, profile.ts), and every
 * arm's `--help` short-circuits before subcommand dispatch, so probing deeper
 * than the first word buys nothing. The hint string itself comes from
 * `installHintFor`, the exact function the status line prints.
 */
describe('every installHint quotes a command main.ts registers', () => {
  for (const variant of SERVICE_VARIANTS) {
    const hint = installHintFor('acct', variant);
    const word = /\btacendum (\S+)/.exec(hint)?.[1];
    it(`the ${variant} hint's command word (${word}) answers --help, not EXIT.USAGE`, async () => {
      // A hint that quotes no command at all would be a different way for
      // this copy to stop being actionable — refuse that shape too.
      expect(word, `the ${variant} installHint (${hint}) quotes no 'tacendum <command>'`).toBeTruthy();
      const { code, stdout } = await runCli([word as string, '--help']);
      expect(
        code,
        `\`tacendum ${word} --help\` exited ${code} — the ${variant} installHint tells the ` +
          'operator to run a command main.ts does not register',
      ).not.toBe(EXIT.USAGE);
      expect(code).toBe(EXIT.OK);
      expect(stdout).toContain('usage:');
    });
  }
});
