import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { stateDir, tacendumHome } from './config.js';
import { CliError, EXIT } from './exit.js';
import { builtEntryPath } from './mcp-install.js';
import { type Reporter } from './output.js';
import { loadProfile } from './profile.js';
import { writeFileAtomic } from './stores.js';

/**
 * `tacendum service install|uninstall|status <account>` — keep `listen`
 * alive as a login agent, so nobody ever types `sync` (operator request:
 * "it is not ideal for a normal user to do these").
 *
 * WHY A SERVICE AND NOT A SHORTCUT. The tempting fix was to drain the inbox
 * opportunistically inside `notify`, but the one-shot send path deliberately
 * NEVER claims the account's routing row — that is what guarantees it can
 * never steal delivery from a live `listen` (send.ts records the rule). A
 * supervised `listen` is the shape that fits the design: launchd on macOS,
 * a systemd user unit on Linux, Windows not implemented rather than
 * pretended (the storage permission checks are POSIX, and this file would
 * only extend that truth).
 *
 * WHAT THE SERVICE WRITES, AND WHERE ITS OUTPUT GOES. stdout is discarded:
 * `listen` prints message BODIES, and a supervisor log would be a SECOND
 * plaintext copy outside the spool's retention passes — an unbounded file
 * the redaction clock never visits. The spool (which `listen` writes anyway)
 * is the record; the service log carries stderr only, under the account's
 * 0700 state dir. RESTART IS THROTTLED to one attempt per minute: a listen
 * dying on dead credentials would otherwise relaunch every few seconds,
 * and a sign-in costs requests against the same per-IP bucket every other
 * integration on this network shares.
 *
 * The unit files are OURS — label-scoped names in directories the OS gives
 * the user — so install overwrites and uninstall removes without ceremony;
 * the atomic writer still guards against a torn file, because launchd reads
 * plists at unpredictable times.
 */

export interface ServiceIo {
  /** Spawn seam for launchctl/systemctl, injectable so tests never touch
   * the real service manager. Returns stdout; throws on nonzero exit. */
  exec?: (file: string, args: string[]) => string;
  platform?: NodeJS.Platform;
  nodePath?: string;
  entryPath?: string;
  /** Unit-file directory override (tests point this at a temp dir). */
  unitDir?: string;
}

/**
 * Three supervised programs, one machine:
 * `listen` receives messages, `attend` answers the OWNER's, `review-peer`
 * answers ANYONE with canned copy (review-peer.ts holds why that predicate is
 * only safe without an agent behind it). They share every rule in this file —
 * the discarded stdout, the throttle, the atomic unit write, the control-char
 * refusal — and differ only in label, argv, log file and prose. Separate units
 * on purpose: an answerer that crash-loops must never cost the operator
 * DELIVERY, which is exactly the coupling the design rejected when it refused
 * to make attend a mode of listen.
 *
 * THE 60-SECOND THROTTLE BELOW IS NOT NEGOTIABLE FOR THE THIRD ONE EITHER:
 * a crash-looping unit re-authenticates on every restart, and
 * sign-ins come out of a per-IP bucket at 30/min that every integration on the
 * network shares.
 *
 * `review-peer run` IS REGISTERED NOW, and the install refusal the
 * old paragraph here asked for exists — with a DIFFERENT predicate than
 * attend's, because the state that crash-loops each unit is different.
 * attend's installer refuses a missing CONFIG, the state in which its
 * program exits immediately. The review peer has no `enable` and needs no
 * config (`reviewReplies` ships a default rotation), so a config-presence
 * check would refuse nothing; what kills ITS program at startup is an
 * integration-class account — `reviewPeerOnce` throws that refusal before
 * the first pass — so `cmdReviewPeerService` (review-peer.ts) refuses
 * `install` on the account class, with the loop's own sentence. The variant
 * shipped unregistered for a while, and the gap was
 * invisible to every test; `gate.unit-program-registered.test.ts` now asks
 * the built entry, per variant, whether its program word answers `--help` —
 * it was red on exactly this before the registration, and it goes red for
 * the next variant that ships the same way.
 */
/**
 * A RUNTIME LIST, not only a type, because the invariant that matters about
 * this set — every variant's unit runs a program word main.ts actually
 * registers — is one a test has to ask of each member, and a type-only union
 * cannot be enumerated. `gate.unit-program-registered.test.ts` walks this
 * array, takes `programArgs(...)[0]`, and requires the built entry to answer
 * `--help` for it; a variant added here without a registration goes red there
 * instead of crash-looping on the first operator who installs it.
 */
export const SERVICE_VARIANTS = ['listen', 'attend', 'review-peer', 'calls'] as const;
export type ServiceVariant = (typeof SERVICE_VARIANTS)[number];

/**
 * Per-variant prose, in one place. It was three inline ternaries on
 * `variant === 'attend'`, which a THIRD variant silently mis-answers: every one
 * of them falls through to the listen sentence, so uninstalling the review peer
 * would have reported "messages now wait for listen or sync" — the wrong
 * program described to an operator who is deciding whether the thing they just
 * removed was the thing they meant.
 */
const VARIANT_COPY: Record<
  ServiceVariant,
  {
    /** The systemd Description tail. */
    what: string;
    installed: (account: string, unit: string) => string;
    uninstalled: (account: string) => string;
    /** The remedy clause when status finds nothing installed — "install
     * with: <command>" for a variant with a wired installer; the variant
     * with none states that instead, because the frame "install with:"
     * imposed at the print site would be the lie the copy exists to avoid. */
    installHint: (account: string) => string;
  }
> = {
  listen: {
    what: 'listen — end-to-end encrypted message intake',
    installed: (account, unit) =>
      `${account}: listen now runs as a login agent (${unit}) — it starts at login, ` +
      'restarts if it dies (at most once a minute), and your messages arrive without sync',
    uninstalled: account =>
      `${account}: the login agent is stopped and removed — messages now wait for listen or sync`,
    installHint: account => `install with: tacendum service install ${account}`,
  },
  attend: {
    what: 'attend — answers the owner’s messages',
    installed: (account, unit) =>
      `${account}: attend now runs as a login agent (${unit}) — it starts at login, restarts ` +
      'if it dies (at most once a minute), and your messages get answered without a terminal',
    uninstalled: account =>
      `${account}: the attend agent is stopped and removed — messages arrive but nothing answers`,
    installHint: account => `install with: tacendum attend service install ${account}`,
  },
  calls: {
    what: 'calls — declines incoming calls so a sleeping account is not a ringing one',
    installed: (account, unit) =>
      `${account}: the call listener now runs as a login agent (${unit}) — it starts at login, ` +
      'restarts if it dies (at most once a minute), and declines calls instead of letting them ring out',
    uninstalled: account =>
      `${account}: the call listener is stopped and removed — calls now ring until they time out`,
    // THE TRUTH, not the pattern. The other three hints name the command that
    // reaches `cmdService` for their variant; NOTHING reaches it with 'calls'
    // (main.ts wires `service`, attend.ts `attend service`, review-peer.ts
    // `review-peer service` — and grep finds no fourth). The old hint
    // completed the pattern instead — `tacendum calls service install` — a
    // command main.ts does not register, so the one operator who followed it
    // got HELP and exit 9. Until an installer is wired, the honest hint is
    // the unit's own program, derived from `programArgs` so it cannot drift
    // from what an installed unit would actually run.
    installHint: account =>
      'no install command is wired for the calls unit yet — run its program ' +
      `directly: tacendum ${programArgs(account, 'calls').join(' ')}`,
  },
  'review-peer': {
    what: 'review peer — canned replies to anyone, no agent behind it',
    installed: (account, unit) =>
      `${account}: the review peer now runs as a login agent (${unit}) — it starts at login, ` +
      'restarts if it dies (at most once a minute), and answers anyone who writes with fixed copy',
    uninstalled: account =>
      `${account}: the review peer is stopped and removed — messages arrive and nothing answers them`,
    installHint: account => `install with: tacendum review-peer service install ${account}`,
  },
};
/**
 * EXPORTED for the hint gate (gate.unit-program-registered.test.ts), under
 * the same contract `programArgs` carries: a status line that quotes a
 * command back at an operator is a claim about main.ts's dispatch, and the
 * gate walks every variant's hint and requires the quoted command word to
 * answer `--help`. `cmdService status` prints THIS function's return value,
 * not a copy of it, so what the gate certifies is what the operator reads.
 */
export function installHintFor(account: string, variant: ServiceVariant): string {
  return VARIANT_COPY[variant].installHint(account);
}

const LABEL_PREFIX = 'com.miranatechnologies.tacendum.';

function realExec(file: string, args: string[]): string {
  return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Unit files cannot carry control characters, and no escape can save them:
 * XML 1.0 forbids them OUTRIGHT (a plist with an escaped U+0001 is still
 * unparsable — the gate proved it with a TACENDUM_HOME carrying one), and a
 * NEWLINE in a systemd `Environment=` value would end the directive and
 * start another: unit-file injection from an environment variable. The
 * values here are the operator's own, so the attacker is a typo or a
 * wrapper script — but a service that silently writes a unit its manager
 * cannot load is a service that lies about being installed. Refuse, naming
 * the value's ROLE and never its content (it may be exactly the garbage we
 * cannot print).
 */
function refuseControlChars(value: string, role: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new CliError(
      EXIT.ERROR,
      `the ${role} contains control characters — launchd and systemd unit files cannot carry ` +
        'them; fix the value and re-run',
    );
  }
  return value;
}

/** The label (and file basename) for an account's agent. The account name is
 * shape-checked by loadProfile before any of this runs, so the label stays
 * within launchd's comfortable character set. */
export function serviceLabel(account: string, variant: ServiceVariant = 'listen'): string {
  return `${LABEL_PREFIX}${variant}.${account}`;
}

export function unitPathFor(
  account: string,
  io: ServiceIo = {},
  variant: ServiceVariant = 'listen',
): string {
  const platform = io.platform ?? process.platform;
  if (platform === 'darwin') {
    return join(
      io.unitDir ?? join(homedir(), 'Library', 'LaunchAgents'),
      `${serviceLabel(account, variant)}.plist`,
    );
  }
  return join(
    io.unitDir ?? join(homedir(), '.config', 'systemd', 'user'),
    `tacendum-${variant}-${account}.service`,
  );
}

/** stderr only — the doc block above records why stdout is discarded. One
 * file per variant: interleaved stderr from two supervised programs is a log
 * nobody can read at 2am. */
function errLogPath(account: string, variant: ServiceVariant = 'listen'): string {
  // `listen` keeps the historical name — an installed unit already points at
  // `service.err.log`, and renaming it would strand the file an operator is
  // tailing. Every other variant is named after itself.
  return join(stateDir(account), variant === 'listen' ? 'service.err.log' : `${variant}.err.log`);
}

/** What the unit runs. The account is a positional in every arm, so the
 * control-char refusal covers it either way. The two answerers take the same
 * `<variant> run <account>` shape; `listen` predates it, and `calls` is a
 * flag-set over `listen` rather than a command of its own.
 *
 * `--seconds 0` is the whole point of the calls arm: it means "run until
 * killed" (main.ts `cmdListenCalls`), which is what makes the unit's
 * restart-on-death contract meaningful. Any bounded value would have the
 * supervisor faithfully resurrecting a listener that then exits on its own
 * timer — a crash-loop wearing a schedule. Paired with `--auto-decline`
 * deliberately and never `--auto-answer`: the CLI carries no media, so an
 * answered call dies inside 45 seconds and reads as a broken product where a
 * decline reads as a closed door.
 *
 * EXPORTED for the unit-program gate: element 0 is the command word the
 * supervised unit hands to main.ts, and a word main.ts does not register is a
 * unit whose program prints HELP and exits EXIT.USAGE — a crash-loop pinned
 * at the throttle floor, which launchd will never explain to the operator.
 * The gate asks the built entry, per variant, whether that word answers. */
export function programArgs(account: string, variant: ServiceVariant): string[] {
  if (variant === 'listen') return ['listen', account, '--plain'];
  if (variant === 'calls') {
    return ['listen', account, '--calls', '--auto-decline', '--seconds', '0', '--plain'];
  }
  return [variant, 'run', account, '--plain'];
}

export function renderLaunchdPlist(
  account: string,
  io: ServiceIo = {},
  variant: ServiceVariant = 'listen',
): string {
  const rawNode = refuseControlChars(io.nodePath ?? process.execPath, 'node path');
  const node = xmlEscape(rawNode);
  const entry = xmlEscape(refuseControlChars(io.entryPath ?? builtEntryPath(), 'entry path'));
  const errLog = xmlEscape(refuseControlChars(errLogPath(account, variant), 'log path'));
  refuseControlChars(account, 'account name');
  // launchd hands a login agent a MINIMAL PATH — /usr/bin:/bin:/usr/sbin:/sbin
  // and nothing else — so the directory holding THIS node is absent. The
  // answerers shell out to host agent binaries (codex, claude) whose entry is
  // `#!/usr/bin/env node`; with node off PATH that env lookup fails and the
  // agent surfaces as "missing or not runnable". This already bit a deployed
  // unit that had to be hand-patched. Put node's OWN directory first — derived
  // from the exact node this unit runs (`dirname` of process.execPath, or the
  // injected nodePath), which is why an nvm/Herd install with no fixed prefix
  // still resolves — then the system bins, so the intended node wins. Drop the
  // node dir only in the (unlikely) case it already IS a system bin.
  const nodeDir = dirname(rawNode);
  const SYSTEM_BINS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const pathValue = (SYSTEM_BINS.includes(nodeDir) ? SYSTEM_BINS : [nodeDir, ...SYSTEM_BINS]).join(
    ':',
  );
  // EnvironmentVariables is now ALWAYS present (PATH is not optional); the
  // custom home rides in the same dict when the operator set one.
  const envPairs = [`      <key>PATH</key><string>${xmlEscape(pathValue)}</string>`];
  if (process.env.TACENDUM_HOME) {
    envPairs.push(
      `      <key>TACENDUM_HOME</key><string>${xmlEscape(refuseControlChars(tacendumHome(), 'TACENDUM_HOME value'))}</string>`,
    );
  }
  const home = `\n    <key>EnvironmentVariables</key>\n    <dict>\n${envPairs.join('\n')}\n    </dict>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>${xmlEscape(serviceLabel(account, variant))}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${node}</string>
      <string>${entry}</string>
${programArgs(account, variant)
  .map(a2 => `      <string>${xmlEscape(a2)}</string>`)
  .join('\n')}
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ThrottleInterval</key><integer>60</integer>
    <key>StandardOutPath</key><string>/dev/null</string>
    <key>StandardErrorPath</key><string>${errLog}</string>${home}
  </dict>
</plist>
`;
}

/**
 * One ExecStart= or Environment= word, written the way systemd reads it
 * back. systemd word-splits those directives (double quotes group, with
 * C-style backslash escapes) and expands `%` specifiers in them — `%%` is
 * the literal percent (systemd.unit(5) §Specifiers). A tame word passes
 * through byte-identical, so already-installed units do not churn on
 * reinstall; anything else is double-quoted. Not a security boundary:
 * nothing here is attacker-controlled and newlines are refused by
 * refuseControlChars before this runs — this is what makes a home with a
 * space or a percent produce a unit the manager parses instead of one that
 * execs half a path.
 */
const SYSTEMD_PLAIN_WORD = /^[A-Za-z0-9_@+=:,./-]+$/;
function systemdWord(value: string): string {
  if (SYSTEMD_PLAIN_WORD.test(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
}

/** A path in a directive that takes the raw remainder of the line
 * (`StandardError=append:…`): no word-splitting there, so a space needs no
 * quoting — but `%` is still specifier syntax and must be doubled. */
function systemdPath(value: string): string {
  return value.replace(/%/g, '%%');
}

export function renderSystemdUnit(
  account: string,
  io: ServiceIo = {},
  variant: ServiceVariant = 'listen',
): string {
  const node = refuseControlChars(io.nodePath ?? process.execPath, 'node path');
  const entry = refuseControlChars(io.entryPath ?? builtEntryPath(), 'entry path');
  refuseControlChars(account, 'account name');
  const errLog = refuseControlChars(errLogPath(account, variant), 'log path');
  const env = process.env.TACENDUM_HOME
    ? `\nEnvironment=${systemdWord(`TACENDUM_HOME=${refuseControlChars(tacendumHome(), 'TACENDUM_HOME value')}`)}`
    : '';
  const what = VARIANT_COPY[variant].what;
  return `[Unit]
Description=Tacendum ${variant} (${account}) — ${what}

[Service]
ExecStart=${[node, entry, ...programArgs(account, variant)].map(systemdWord).join(' ')}
Restart=always
RestartSec=60
StandardOutput=null
StandardError=append:${systemdPath(errLog)}${env}

[Install]
WantedBy=default.target
`;
}

/** Every registered account in this home: a directory holding a
 * profile.json, which excludes the `state/` and `locks/` compartments that
 * share the root. Account names are the operator's own typed input, already
 * shape-checked at registration. */
export function listAccounts(): string[] {
  let names: string[];
  try {
    names = readdirSync(tacendumHome());
  } catch {
    return [];
  }
  return names
    .filter(n => n !== 'state' && n !== 'locks')
    .filter(n => existsSync(join(tacendumHome(), n, 'profile.json')))
    .sort();
}

/**
 * EXPORTED, because two other surfaces report the unit's state and must not
 * become second implementations of this read: `attend status` (attend.ts)
 * and doctor's attend check both answer "is the answerer supervised, and is
 * it alive?" from here. Read-only in the observe-never-repair sense —
 * `launchctl print` and `systemctl is-active` query the manager and mutate
 * nothing — so a status command and a doctor probe may both call it freely.
 */
export function statusOf(
  account: string,
  io: ServiceIo = {},
  variant: ServiceVariant = 'listen',
): { installed: boolean; running: boolean; unit: string } {
  const exec = io.exec ?? realExec;
  const platform = io.platform ?? process.platform;
  const unit = unitPathFor(account, io, variant);
  if (!existsSync(unit)) return { installed: false, running: false, unit };
  let running = false;
  try {
    if (platform === 'darwin') {
      const uid = process.getuid?.() ?? 501;
      running = /state = running/.test(exec('/bin/launchctl', ['print', `gui/${uid}/${serviceLabel(account, variant)}`]));
    } else {
      running = exec('systemctl', ['--user', 'is-active', `tacendum-${variant}-${account}.service`]).trim() === 'active';
    }
  } catch {
    running = false;
  }
  return { installed: true, running, unit };
}

export function cmdService(
  sub: string,
  account: string | null,
  report: Reporter,
  io: ServiceIo = {},
  variant: ServiceVariant = 'listen',
): void {
  const platform = io.platform ?? process.platform;
  if (platform !== 'darwin' && platform !== 'linux') {
    throw new CliError(EXIT.ERROR, 'the service is implemented for macOS (launchd) and Linux (systemd --user) only');
  }

  // Bare `status` answers for EVERY account — status is a question, and a
  // question deserves the whole answer (operator request: two
  // bare invocations in a row are a vote). install/uninstall MUTATE, so
  // they stay explicit — but an omitted account names the options instead
  // of reciting usage at somebody who has exactly one obvious intent.
  if (account === null && sub === 'status') {
    const accounts = listAccounts();
    if (accounts.length === 0) {
      report.emit(
        { ok: true, action: 'service-status', accounts: [] },
        'no accounts registered here — tacendum register <name> comes first',
      );
      return;
    }
    for (const name of accounts) {
      const s = statusOf(name, io, variant);
      report.line(
        { ok: true, action: 'service-status', account: name, installed: s.installed, running: s.running },
        `${name}: ${!s.installed ? 'no service installed' : s.running ? 'service running' : 'service installed, NOT running'}`,
      );
    }
    return;
  }
  if (account === null) {
    const accounts = listAccounts();
    const hint =
      accounts.length === 0
        ? 'no accounts registered here'
        : `accounts here: ${accounts.join(', ')}`;
    throw new CliError(EXIT.USAGE, `usage: tacendum service ${sub} <account> — ${hint}`);
  }

  // A service for an unregistered account would crash-loop forever at its
  // throttle floor; refuse with the fixable mistake named instead.
  loadProfile(account);
  const exec = io.exec ?? realExec;
  const unit = unitPathFor(account, io, variant);
  const label = serviceLabel(account, variant);

  if (sub === 'install') {
    mkdirSync(dirname(unit), { recursive: true });
    mkdirSync(stateDir(account), { recursive: true, mode: 0o700 });
    if (platform === 'darwin') {
      writeFileAtomic(unit, renderLaunchdPlist(account, io, variant), { mode: 0o644 });
      const uid = process.getuid?.() ?? 501;
      // bootout first so a re-install picks up the fresh plist: launchd
      // ignores a bootstrap for a label it already holds. A bootout for a
      // label that is not loaded fails, and that failure is the fine case.
      try {
        exec('/bin/launchctl', ['bootout', `gui/${uid}/${label}`]);
      } catch {
        /* not loaded — nothing to boot out */
      }
      try {
        exec('/bin/launchctl', ['bootstrap', `gui/${uid}`, unit]);
      } catch {
        // launchd answers EIO ("Bootstrap failed: 5") to a bootstrap that
        // races its own teardown of the same label — which is exactly what
        // the bootout above sets up when a previous install is running.
        // Found live on the first real re-install. One beat, one retry;
        // a second failure is real and surfaces as OUR sentence, because
        // launchctl's "try re-running as root" is advice that would make
        // things worse (a root-domain agent for a user account).
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
        try {
          exec('/bin/launchctl', ['bootstrap', `gui/${uid}`, unit]);
        } catch {
          throw new CliError(
            EXIT.ERROR,
            `launchd refused the agent twice — the unit file is in place (${unit}); ` +
              `load it once by hand: launchctl bootstrap gui/${uid} ${unit}`,
          );
        }
      }
    } else {
      writeFileAtomic(unit, renderSystemdUnit(account, io, variant), { mode: 0o644 });
      exec('systemctl', ['--user', 'daemon-reload']);
      exec('systemctl', ['--user', 'enable', '--now', `tacendum-${variant}-${account}.service`]);
    }
    report.emit(
      { ok: true, action: 'service-installed', account, variant, unit },
      VARIANT_COPY[variant].installed(account, unit),
    );
    return;
  }

  if (sub === 'uninstall') {
    if (platform === 'darwin') {
      const uid = process.getuid?.() ?? 501;
      try {
        exec('/bin/launchctl', ['bootout', `gui/${uid}/${label}`]);
      } catch {
        /* already stopped */
      }
    } else {
      try {
        exec('systemctl', ['--user', 'disable', '--now', `tacendum-${variant}-${account}.service`]);
      } catch {
        /* already stopped */
      }
    }
    rmSync(unit, { force: true });
    report.emit(
      { ok: true, action: 'service-uninstalled', account, variant },
      VARIANT_COPY[variant].uninstalled(account),
    );
    return;
  }

  if (sub === 'status') {
    const s = statusOf(account, io, variant);
    if (!s.installed) {
      report.emit(
        { ok: true, action: 'service-status', account, installed: false, running: false },
        `${account}: no ${variant} service installed — ${installHintFor(account, variant)}`,
      );
      return;
    }
    report.emit(
      { ok: true, action: 'service-status', account, installed: true, running: s.running },
      `${account}: ${variant} service installed, ${s.running ? 'running' : 'NOT running — check ' + errLogPath(account, variant)}`,
    );
    return;
  }

  throw new CliError(EXIT.USAGE, 'usage: tacendum service install|uninstall|status <account>');
}
