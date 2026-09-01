import { beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `tacendum service` — the login agent that keeps `listen` alive.
 *
 * Everything runs against the exec seam: no test may touch the real
 * launchctl or systemctl (the HOME pin would make their unit paths fake,
 * and a bootstrap against a fake plist fails in ways that teach nothing).
 * What IS under test: the unit files say exactly what the doc block
 * promises (stdout discarded, restart throttled, absolute paths), install
 * re-loads a fresh unit, uninstall stops before it removes, and status
 * tells the truth from the manager's answer.
 */

const home = mkdtempSync(join(tmpdir(), 'tacendum-svc-'));
process.env.TACENDUM_HOME = home;
process.env.TACENDUM_API = 'http://svc.test';
process.env.TACENDUM_WS = 'ws://svc.test';

const { cmdService, renderLaunchdPlist, renderSystemdUnit, serviceLabel, unitPathFor } =
  await import('../src/service.js');
const { saveProfile } = await import('../src/profile.js');
const { EXIT } = await import('../src/exit.js');
const { Reporter } = await import('../src/output.js');

const report = () => new Reporter({ json: false, plain: true });

let calls: { file: string; args: string[] }[] = [];
let execAnswers: Record<string, string | Error> = {};
function fakeExec(file: string, args: string[]): string {
  calls.push({ file, args });
  const key = `${file} ${args.join(' ')}`;
  for (const [pattern, answer] of Object.entries(execAnswers)) {
    if (key.includes(pattern)) {
      if (answer instanceof Error) throw answer;
      return answer;
    }
  }
  return '';
}

let unitDir: string;
beforeEach(() => {
  calls = [];
  execAnswers = {};
  unitDir = mkdtempSync(join(tmpdir(), 'tacendum-units-'));
  saveProfile({
    name: 'claude-code',
    identityKey: 'AAAA',
    userId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    deviceId: 1,
    authToken: 'tok',
    registrationId: 1,
    accountClass: 'integration',
  });
});

const io = (platform: NodeJS.Platform = 'darwin') => ({
  exec: fakeExec,
  platform,
  unitDir,
  nodePath: '/opt/node/bin/node',
  entryPath: '/repo/packages/cli/dist/main.js',
});

describe('the unit files keep the doc block honest', () => {
  it('launchd: absolute paths, stdout to /dev/null, one restart a minute', () => {
    const plist = renderLaunchdPlist('claude-code', io());
    expect(plist).toContain('<string>/opt/node/bin/node</string>');
    expect(plist).toContain('<string>/repo/packages/cli/dist/main.js</string>');
    expect(plist).toContain('<string>listen</string>');
    expect(plist).toContain('<string>claude-code</string>');
    // stdout is message BODIES — a service log would be a second plaintext
    // copy outside the spool's retention passes.
    expect(plist).toContain('<key>StandardOutPath</key><string>/dev/null</string>');
    expect(plist).toContain('<key>ThrottleInterval</key><integer>60</integer>');
    // The custom home this test runs under must ride along, or the agent
    // would listen for an account that does not exist in the default home.
    expect(plist).toContain(`<string>${home}</string>`);
  });

  it('launchd: node rides PATH, so a `#!/usr/bin/env node` agent resolves under launchd', () => {
    // launchd hands a login agent only /usr/bin:/bin:/usr/sbin:/sbin — the
    // directory holding THIS node is absent. attend shells to host agent
    // binaries (codex, claude) whose entry is `#!/usr/bin/env node`; with node
    // off PATH that env lookup fails and the agent reads as "missing or not
    // runnable". A deployed unit had to be hand-patched for exactly this.
    const plist = renderLaunchdPlist('claude-code', io());
    expect(plist).toContain('<key>EnvironmentVariables</key>');
    // node's own dir (dirname of the exact node this unit runs) FIRST, so the
    // intended node wins, then the system bins.
    expect(plist).toContain(
      '<key>PATH</key><string>/opt/node/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>',
    );
  });

  it('systemd: the same promises in the other dialect', () => {
    const unit = renderSystemdUnit('claude-code', io('linux'));
    expect(unit).toContain('ExecStart=/opt/node/bin/node /repo/packages/cli/dist/main.js listen claude-code --plain');
    expect(unit).toContain('StandardOutput=null');
    expect(unit).toContain('RestartSec=60');
    expect(unit).toContain(`Environment=TACENDUM_HOME=${home}`);
  });
});

describe('systemd values are escaped for systemd, not pasted', () => {
  // systemd word-splits ExecStart= and expands % specifiers in ExecStart=,
  // Environment= and the Standard*= file paths (%% is the literal escape).
  // Nothing interpolated here is attacker-controlled and newlines are
  // already refused above — this is correctness: a home with a space or a
  // percent must produce a unit the manager parses, not one that execs
  // "/opt/my" or expands %F.
  it('quotes ExecStart words carrying spaces and doubles their %', () => {
    const unit = renderSystemdUnit('claude-code', {
      ...io('linux'),
      nodePath: '/opt/my node/bin/node',
      entryPath: '/repo/50% done/dist/main.js',
    });
    expect(unit).toContain(
      'ExecStart="/opt/my node/bin/node" "/repo/50%% done/dist/main.js" listen claude-code --plain',
    );
  });

  it('quotes an Environment= home with a space and doubles its % — log path included', () => {
    const original = process.env.TACENDUM_HOME;
    process.env.TACENDUM_HOME = '/home/user/My Files/tacendum 50%';
    try {
      const unit = renderSystemdUnit('claude-code', io('linux'));
      expect(unit).toContain('Environment="TACENDUM_HOME=/home/user/My Files/tacendum 50%%"');
      // append: takes the raw remainder of the line, so a space needs no
      // quoting there — but % is still specifier syntax.
      expect(unit).toContain(
        'StandardError=append:/home/user/My Files/tacendum 50%%/state/claude-code/service.err.log',
      );
    } finally {
      process.env.TACENDUM_HOME = original;
    }
  });

  it('leaves the tame ordinary case byte-identical: no quotes appear', () => {
    const unit = renderSystemdUnit('claude-code', io('linux'));
    expect(unit).toContain('ExecStart=/opt/node/bin/node /repo/packages/cli/dist/main.js listen claude-code --plain');
    expect(unit).not.toContain('"');
  });
});

describe('the attend variant shares every rule and none of the state', () => {
  it('label, unit path, argv and log file are all distinct from the listener', () => {
    expect(serviceLabel('claude-code')).toBe('com.miranatechnologies.tacendum.listen.claude-code');
    expect(serviceLabel('claude-code', 'attend')).toBe('com.miranatechnologies.tacendum.attend.claude-code');
    expect(unitPathFor('claude-code', io(), 'attend')).not.toBe(unitPathFor('claude-code', io()));
    const plist = renderLaunchdPlist('claude-code', io(), 'attend');
    expect(plist).toContain('<string>attend</string>');
    expect(plist).toContain('<string>run</string>');
    expect(plist).toContain('attend.err.log');
    // The rules it SHARES — the listener's whole discipline.
    expect(plist).toContain('<key>StandardOutPath</key><string>/dev/null</string>');
    expect(plist).toContain('<key>ThrottleInterval</key><integer>60</integer>');
    // PATH rides the shared generator too — and the answerer NEEDS it, being
    // the variant that shells to node-shebang agents.
    expect(plist).toContain(
      '<key>PATH</key><string>/opt/node/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>',
    );
    const unit = renderSystemdUnit('claude-code', io('linux'), 'attend');
    expect(unit).toContain('attend run claude-code --plain');
    expect(unit).toContain('StandardOutput=null');
  });

  it('installing both leaves two units, and uninstalling one leaves the other', () => {
    cmdService('install', 'claude-code', report(), io());
    cmdService('install', 'claude-code', report(), io(), 'attend');
    expect(existsSync(unitPathFor('claude-code', io()))).toBe(true);
    expect(existsSync(unitPathFor('claude-code', io(), 'attend'))).toBe(true);
    cmdService('uninstall', 'claude-code', report(), io(), 'attend');
    // Delivery must survive the answerer being removed — the whole reason
    // they are separate units.
    expect(existsSync(unitPathFor('claude-code', io()))).toBe(true);
    expect(existsSync(unitPathFor('claude-code', io(), 'attend'))).toBe(false);
  });
});

describe('control characters are refused, not escaped — no unit file can carry them', () => {
  // The gate proved a TACENDUM_HOME with U+0001 renders the plist UNPARSABLE
  // (XML 1.0 forbids control chars outright, escaped or not), and a newline
  // in a systemd Environment= value would END the directive: injection.
  it('launchd refuses a control-byte home instead of writing garbage', () => {
    const original = process.env.TACENDUM_HOME;
    process.env.TACENDUM_HOME = '/tmp/evil-\u0001-home';
    try {
      expect(() => renderLaunchdPlist('claude-code', io())).toThrowError(/control characters/);
    } finally {
      process.env.TACENDUM_HOME = original;
    }
  });

  it('systemd refuses a newline home instead of writing a second directive', () => {
    const original = process.env.TACENDUM_HOME;
    process.env.TACENDUM_HOME = '/tmp/x\nExecStartPre=/bin/evil';
    try {
      expect(() => renderSystemdUnit('claude-code', io('linux'))).toThrowError(/control characters/);
    } finally {
      process.env.TACENDUM_HOME = original;
    }
  });

  it('a control byte in an injected path refuses too', () => {
    expect(() =>
      renderLaunchdPlist('claude-code', { ...io(), nodePath: '/opt/no\u0007de' }),
    ).toThrowError(/control characters/);
  });
});

describe('install / uninstall / status, against the manager seam', () => {
  it('install writes the plist then bootout-before-bootstrap, so a re-install loads the FRESH unit', () => {
    execAnswers['bootout'] = new Error('not loaded');
    cmdService('install', 'claude-code', report(), io());
    const unit = unitPathFor('claude-code', io());
    expect(readFileSync(unit, 'utf8')).toContain(serviceLabel('claude-code'));
    const seq = calls.map(c => c.args[0]);
    expect(seq).toEqual(['bootout', 'bootstrap']);
    // The bootout failure (label not loaded) did not stop the install.
    expect(calls[1]!.args[2]).toBe(unit);
  });

  it('a bootstrap that races the bootout teardown (launchd EIO) is retried once and succeeds', () => {
    // Found live: the first real re-install boot-out a RUNNING agent and the
    // immediate bootstrap answered "Bootstrap failed: 5: Input/output error".
    let bootstraps = 0;
    const flaky = (file: string, args: string[]): string => {
      calls.push({ file, args });
      if (args[0] === 'bootstrap' && ++bootstraps === 1) {
        throw new Error('Bootstrap failed: 5: Input/output error');
      }
      return '';
    };
    cmdService('install', 'claude-code', report(), { ...io(), exec: flaky });
    expect(calls.map(c => c.args[0])).toEqual(['bootout', 'bootstrap', 'bootstrap']);
  });

  it('a bootstrap that fails twice surfaces OUR remedy, never launchctl’s run-as-root advice', () => {
    execAnswers['bootstrap'] = new Error('Bootstrap failed: 5: Input/output error');
    const err = (() => {
      try {
        cmdService('install', 'claude-code', report(), io());
        return null;
      } catch (e) {
        return e as CliError;
      }
    })();
    expect(err?.exitCode).toBe(EXIT.ERROR);
    expect(err?.message).toContain('by hand');
    expect(err?.message).not.toContain('root');
  });

  it('uninstall stops the agent and removes the unit file', () => {
    cmdService('install', 'claude-code', report(), io());
    calls = [];
    cmdService('uninstall', 'claude-code', report(), io());
    expect(calls.map(c => c.args[0])).toEqual(['bootout']);
    expect(existsSync(unitPathFor('claude-code', io()))).toBe(false);
  });

  it('status reads the manager, not wishes: running only when launchd says running', () => {
    cmdService('install', 'claude-code', report(), io());
    execAnswers['print'] = 'state = running\npid = 4242';
    cmdService('status', 'claude-code', report(), io());
    execAnswers['print'] = new Error('Could not find service');
    // Not running must not throw — it is an ANSWER.
    cmdService('status', 'claude-code', report(), io());
  });

  it('linux takes the systemctl path end to end', () => {
    cmdService('install', 'claude-code', report(), io('linux'));
    expect(calls.map(c => `${c.file} ${c.args.join(' ')}`)).toEqual([
      'systemctl --user daemon-reload',
      'systemctl --user enable --now tacendum-listen-claude-code.service',
    ]);
    expect(readFileSync(unitPathFor('claude-code', io('linux')), 'utf8')).toContain('Restart=always');
  });

  it('refuses an unregistered account before touching the manager — a crash-looping agent helps nobody', () => {
    expect(() => cmdService('install', 'ghost', report(), io())).toThrowError();
    expect(calls).toHaveLength(0);
  });

  it('bare status answers for EVERY account, one line each', () => {
    // Two registered accounts, one with a service installed.
    saveProfile({
      name: 'ci-bot',
      identityKey: 'AAAA',
      userId: '01BX5ZZKBKACTAV9WEVGEMMVRY',
      deviceId: 1,
      authToken: 'tok2',
      registrationId: 2,
      accountClass: 'integration',
    });
    cmdService('install', 'claude-code', report(), io());
    execAnswers['print'] = 'state = running';
    const out: string[] = [];
    const spy = { line: (_r: unknown, human: string) => void out.push(human) };
    cmdService('status', null, { ...report(), line: spy.line } as never, io());
    expect(out.some(l => l.startsWith('ci-bot: no service installed'))).toBe(true);
    expect(out.some(l => l.startsWith('claude-code: service running'))).toBe(true);
  });

  it('a bare MUTATION names the accounts instead of reciting usage', () => {
    const err = (() => {
      try {
        cmdService('install', null, report(), io());
        return null;
      } catch (e) {
        return e as CliError;
      }
    })();
    expect(err?.exitCode).toBe(EXIT.USAGE);
    expect(err?.message).toContain('claude-code');
  });

  it('refuses unknown platforms and unknown subcommands, never exit 2', () => {
    const winErr = (() => {
      try {
        cmdService('install', 'claude-code', report(), io('win32'));
        return null;
      } catch (e) {
        return e as CliError;
      }
    })();
    expect(winErr?.exitCode).toBe(EXIT.ERROR);
    const subErr = (() => {
      try {
        cmdService('restart', 'claude-code', report(), io());
        return null;
      } catch (e) {
        return e as CliError;
      }
    })();
    expect(subErr?.exitCode).toBe(EXIT.USAGE);
    expect(winErr?.exitCode).not.toBe(2);
    expect(subErr?.exitCode).not.toBe(2);
  });
});

describe('the calls variant', () => {
  /**
   * The unit that keeps a sleeping account from being a ringing one.
   *
   * Two facts in its program arguments are load-bearing and neither is
   * obvious from reading the flags, so they are pinned here rather than
   * trusted to the comment beside them.
   */
  it('runs an UNBOUNDED listener — a bounded one would crash-loop on its own timer', () => {
    const plist = renderLaunchdPlist('bot', { nodePath: '/n', cliPath: '/c' }, 'calls');
    // `--seconds 0` means "until killed" (main.ts cmdListenCalls). With any
    // finite value the supervisor would faithfully resurrect a listener that
    // then exits on schedule — a crash-loop wearing a uniform, and one that
    // burns the per-IP auth bucket on every restart.
    expect(plist).toContain('<string>--seconds</string>');
    expect(plist).toContain('<string>0</string>');
    expect(plist).toContain('<string>--calls</string>');
  });

  it('DECLINES rather than answers — the CLI carries no media', () => {
    // An auto-answered call hands the phone a fixture SDP whose fingerprint
    // no DTLS handshake matches, so it connects and dies inside 45 seconds.
    // To an App Review tester that reads as a broken product; a decline
    // reads as a closed door.
    const unit = renderSystemdUnit('bot', { nodePath: '/n', cliPath: '/c' }, 'calls');
    expect(unit).toContain('--auto-decline');
    expect(unit).not.toContain('--auto-answer');
  });

  it('keeps the restart throttle every other variant has', () => {
    // 60s is what stops a restart storm from burning the server's per-IP
    // auth bucket (30/min). Never lower it.
    const unit = renderSystemdUnit('bot', { nodePath: '/n', cliPath: '/c' }, 'calls');
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('RestartSec=60');
  });

  it('does not disturb the other variants\' program arguments', () => {
    // The calls arm was added as a branch above the shared fallback; this is
    // the regression that branch could cause.
    const listen = renderLaunchdPlist('bot', { nodePath: '/n', cliPath: '/c' }, 'listen');
    expect(listen).not.toContain('--calls');
    expect(listen).not.toContain('--seconds');
    const attend = renderLaunchdPlist('bot', { nodePath: '/n', cliPath: '/c' }, 'attend');
    expect(attend).toContain('<string>attend</string>');
    expect(attend).toContain('<string>run</string>');
    expect(attend).not.toContain('--calls');
  });
});
