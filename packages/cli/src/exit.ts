/**
 * Exit codes and the error class that carries them.
 *
 * A notifier is only ever run by something that cannot read: a Makefile, a
 * cron line, a Claude Code hook. `exit 1` for every failure tells that caller
 * nothing, so the one remedy it could apply — retry, re-pair, page a human —
 * is unavailable. These codes exist so `|| tacendum send` chains and CI steps
 * can branch without parsing English.
 *
 * The numbers are a published contract from here on: append, never renumber.
 * 0/1 follow the shell convention (ok / unclassified) so a script that only
 * knows those two still behaves sanely.
 *
 * **2 IS PERMANENTLY UNUSED, and that is the point**.
 * Claude Code reserves hook exit code 2 as the BLOCKING code: a Stop hook
 * that exits 2 forces the agent to keep going and feeds the hook's stderr
 * back to the model as instructions. This CLI's whole reason to exist is to
 * be run from that hook, so a mistyped flag exiting 2 would turn a typo into
 * an agent-control primitive — and a peer-supplied message body echoed into
 * that stderr into a prompt-injection channel. USAGE was 2 until this gate;
 * renumbering it to 9 costs a shell convention nobody depends on and buys a
 * guarantee the target caller does depend on. Nothing may ever take 2.
 */
export const EXIT = {
  /** Everything worked. */
  OK: 0,
  /** Something failed that this CLI could not classify. Retry may help. */
  ERROR: 1,
  // 2 is deliberately absent. See the note above — it is Claude Code's
  // blocking code, and this tool runs inside Claude Code hooks.
  /**
   * Credentials are dead and could not be renewed (renewal already tried once).
   * The account was deleted, the identity key no longer matches, or the
   * server refused a freshly signed challenge. A human must re-pair; a retry
   * loop here is the thing renewal exists to prevent.
   */
  AUTH: 3,
  /** The server was unreachable, or the transport failed before any reply. */
  NETWORK: 4,
  /** The recipient does not exist, or has no prekeys to open a session with. */
  RECIPIENT: 5,
  /**
   * The peer's safety number changed and the send was refused. Distinct from
   * AUTH on purpose: nothing about *our* credentials is wrong, and the remedy
   * is an out-of-band verification, not a re-pair.
   */
  SAFETY: 6,
  /** The server accepted the frame but no receipt arrived in time. */
  TIMEOUT: 7,
  /**
   * Rate limited (HTTP 429). Appended rather than folded into ERROR because
   * this is the one failure whose remedy is "wait, then do exactly the same
   * thing", and it is the shape a fleet produces: N machines whose sessions
   * all expire on the same day re-authenticate at once, and a sign-in costs
   * two requests against a 30/min per-IP bucket. Reported as "unclassified"
   * it looks like dead credentials, and the natural response — a retry
   * wrapper — is precisely what keeps the bucket empty.
   */
  RATELIMIT: 8,
  /**
   * The command line was wrong. Retrying identical arguments cannot help.
   *
   * 9 rather than the conventional 2 — see the note at the top of this table.
   */
  USAGE: 9,
  /**
   * The server refused this send permanently.
   *
   * Distinct from TIMEOUT, which it used to be reported as: the server did
   * answer, with an error frame, and the answer was "no". An integration
   * that is unbound, addressing anyone but its owner, or asking for an
   * urgent frame gets this — none of which a retry can fix, whereas TIMEOUT
   * explicitly invites one. Distinct from USAGE because the arguments were
   * well-formed; what is wrong is the account's standing with the server.
   */
  REFUSED: 10,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * An error that already knows how the process should exit.
 *
 * Everything else thrown in this package is unclassified and lands on
 * `EXIT.ERROR`, which is the honest answer — inventing a code for an error
 * nobody has reasoned about would make the contract above a lie.
 */
export class CliError extends Error {
  readonly exitCode: ExitCode;
  /** Short stable slug for `--json` consumers, e.g. `auth`, `recipient`. */
  readonly slug: string;
  /**
   * The SERVER's error code, when this came from an HTTP response —
   * `owner_conflict`, `identity_tombstoned`, and so on.
   *
   * Carried as a field because the alternative was reading it back out of the
   * formatted message with `includes()`, which is a match against prose: it
   * breaks silently when the message format changes, and it cannot tell two
   * failures apart that share a status. 409 is both `owner_conflict` (an
   * integration already bound — recovery is a new integration) and
   * `account_conflict` (an account mid-deletion — recovery is to register
   * again), and those deserve different sentences.
   */
  readonly code: string | undefined;

  /**
   * The HTTP status, when this came from a response.
   *
   * Distinct from `exitCode`, which deliberately collapses many statuses onto
   * one outcome for the shell. A caller occasionally needs the status back:
   * the WebSocket ticket mint treats 404 — this server predates the route — as
   * the one failure it may downgrade for, and must not confuse it with a 500
   * or a 429 that an attacker could induce.
   */
  readonly status: number | undefined;

  constructor(
    exitCode: ExitCode,
    message: string,
    slug?: string,
    code?: string,
    status?: number,
  ) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.slug = slug ?? slugFor(exitCode);
    this.code = code;
    this.status = status;
  }
}

function slugFor(code: ExitCode): string {
  switch (code) {
    case EXIT.OK:
      return 'ok';
    case EXIT.USAGE:
      return 'usage';
    case EXIT.AUTH:
      return 'auth';
    case EXIT.NETWORK:
      return 'network';
    case EXIT.RECIPIENT:
      return 'recipient';
    case EXIT.SAFETY:
      return 'safety';
    case EXIT.TIMEOUT:
      return 'timeout';
    case EXIT.RATELIMIT:
      return 'rate_limited';
    case EXIT.REFUSED:
      // Its own slug rather than falling through to 'error'. The slug is the
      // documented branch key for --json consumers, and 'error' is
      // documented as "retry may help" — so leaving REFUSED on the default
      // told a machine reader to retry a permanent refusal, which is exactly
      // the misdirection this gate closed on the numeric path.
      return 'refused';
    default:
      return 'error';
  }
}

/** The exit code for anything thrown, classified or not. */
export function exitCodeFor(err: unknown): ExitCode {
  return err instanceof CliError ? err.exitCode : EXIT.ERROR;
}

/** The `--json` error slug for anything thrown. */
export function slugOf(err: unknown): string {
  return err instanceof CliError ? err.slug : 'error';
}
