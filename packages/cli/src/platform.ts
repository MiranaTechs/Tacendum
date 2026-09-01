import { CliError, EXIT } from './exit.js';

/**
 * The Windows front door, and why it is closed.
 *
 * Until this guard existed, running the CLI on Windows was not refused — it
 * was UNDEFINED. `preferredBackend()` (keychain.ts) probes only darwin and
 * linux, so a Windows box silently landed on the `file` backend, whose whole
 * security posture is a `chmod 0600` — a POSIX permission model that does not
 * bind NTFS ACLs. The credential the file holds IS the account, so "runs, but the key sits at whatever
 * the directory's inherited ACL says" is strictly worse than not running:
 * every honest sentence in the README about credential-at-rest would be
 * false on exactly the machine that read it. The same POSIX assumption
 * recurs across the package (0600 backups in hostconfig.ts, lock files,
 * spawn of `security`/`secret-tool`), so the refusal is whole-CLI, not
 * per-backend.
 *
 * WHY REFUSE RATHER THAN CARVE OUT: a Windows carve-out ("file backend at
 * your own risk") is a support claim wearing a flag, and B6 pins the line —
 * no Windows support sentence anywhere until a DPAPI/wincred credential
 * backend exists WITH a CI matrix row. When that backend lands, this guard
 * is deleted in the same commit that adds the CI row, not loosened first.
 *
 * WHY `EXIT.ERROR` AND NOT A NEW CODE: exit.ts's own rule — an error nobody
 * has classified lands on ERROR; minting a contract code for a platform that
 * cannot usefully run the binary spends a forever-number on a refusal whose
 * remedy is prose, not branching. Never 2, like everything else here: 2 is
 * the hook-blocking code and is permanently unused (see exit.ts).
 *
 * WHERE IT RUNS: at the top of `main()`'s dispatch, AFTER `--help` and
 * `--version` — those two are answerable with no account, no store and no
 * filesystem write, and must stay answerable that way (main.ts's own rule);
 * a Windows user asking "what is this?" gets the answer, and the first real
 * command gets the refusal.
 *
 * The platform is a parameter for the same reason `preferredBackend` takes
 * `env`: the refusing arm is untestable from a mac otherwise. Production
 * callers pass nothing.
 */
export function assertPlatformSupported(
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== 'win32') return;
  throw new CliError(
    EXIT.ERROR,
    'Windows is not yet supported — this CLI runs on macOS and Linux. There is no ' +
      'Windows credential backend (DPAPI/wincred), so the account credential would ' +
      'land in the plain-file fallback, whose 0600 permission posture is a POSIX ' +
      'assumption that Windows does not honor. Rather than store a credential it ' +
      'cannot protect, the CLI refuses to run. Windows support arrives with a real ' +
      'credential backend and a CI matrix row.',
  );
}
