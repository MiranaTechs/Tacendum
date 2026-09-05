import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  apiAuth,
  apiAuthChallenge,
  apiIntegrationBind,
  apiUploadKeys,
} from './api.js';
import { flagBool, flagCount, flagString, parseArgs, scanGlobals, type ParsedArgs } from './args.js';
import { listContacts } from './contacts.js';
import { registerForecast, runDoctor } from './doctor.js';
import { CliError, EXIT, exitCodeFor, slugOf, type ExitCode } from './exit.js';
import { attachInbound, watchQuiet } from './inbound.js';
import { runMcpServer } from './mcp.js';
import { runMcpInstall } from './mcp-install.js';
import { runMcpAskServer } from './mcp-ask.js';
import { runMcpNotifyServer } from './mcp-notify.js';
import { MessageLog, takeInbox } from './msglog.js';
import { Reporter } from './output.js';
import {
  isUserId,
  loadProfile,
  normalizeUserId,
  readProfile,
  resolveRecipient,
  saveProfile,
  UnusableTokenError,
} from './profile.js';
import {
  prefixLines,
  redactCredentials,
  sanitizeForTerminal,
  sanitizeServerField,
} from './render.js';
import { AuthSession } from './session.js';
import { FileStores } from './stores.js';
import { withFileLockAsync } from './lock.js';
import { LICENSE, SOURCE_URL, versionInfo } from './version.js';
import {
  DEVICE_ID,
  acceptPeerIdentityChange,
  computeSafetyNumber,
  loadOrGenerateKeys,
  signAuthChallenge,
} from './messaging.js';
import { WsClient } from './wsclient.js';
import { CallSession, readCallLog } from './call-session.js';
import { groupCallStatePath, readGroupCallState } from './group-call.js';
import { cmdNotify } from './hooks.js';
import { cmdRoom } from './room-commands.js';
import { cmdRun } from './run.js';
import { cmdSend } from './send.js';
import { cmdSetup } from './setup.js';
import { cmdCredential, maybeMigrateCredential } from './keychain.js';
import { assertPlatformSupported } from './platform.js';
import { CREW_VOICE_BODY } from './crewvoice.js';
import { cmdCrewAdopt } from './crew.js';
import { cmdConsent, cmdConsentList } from './consent.js';
import { cmdService } from './service.js';
import {
  attendLoop,
  cmdAttendDisable,
  cmdAttendEnable,
  cmdAttendService,
  cmdAttendStatus,
  cmdAttendRounds,
  cmdAttendTriggers,
  parseCapsFlag,
} from './attend.js';
import { cmdReviewPeerService, reviewPeerLoop } from './review-peer.js';

/**
 * The Tacendum CLI.
 *
 *   tacendum register <name>
 *   tacendum send <from> <to|userId> ["<text>"] [--title T] [--drain]
 *   tacendum listen <name> [--calls] [--auto-answer|--auto-decline] [--seconds N]
 *                          [--detail]  (chat stream only, not with --calls)
 *   tacendum sync <name>
 *   tacendum inbox <name> [--peer <id>] [--limit N] [--unread] [--peek] [--detail]
 *   tacendum contacts <name> | doctor <name>
 *   tacendum call <from> <to> [--video] [--ice N] [--seconds N]
 *   tacendum calllog <name> | whoami <name> | safety <a> <b> | trust <a> <b>
 *   tacendum mcp --account <name> | mcp install --host H [--write]
 *
 * Global: --json (machine-readable stdout), --plain (stable stdout, no
 * spinner, no colour), --help, --version. Exit codes are the contract in
 * `exit.ts`. The inbound frame policy lives in `inbound.ts`; the durable
 * message log it writes lives in `msglog.ts`.
 *
 * `<to>` is either a local client name or a bare 26-character user id (C1) —
 * the id path needs nothing on this machine about the recipient, which is the
 * whole point of an integration account.
 */

/**
 * TEST-ONLY affordances, deliberately NOT command-line flags (C6).
 *
 * `--canary` and `--exp-offset` were proof-client scaffolding: one injects a
 * marker into outgoing SDP for the plaintext-leak scan, the other backdates an
 * offer so a stale invite can be tested in seconds instead of ninety. Neither
 * belongs on a tool someone installs — a flag that exists can be typed, and
 * `--exp-offset` in particular lets a caller mint an already-expired call.
 *
 * They are not deleted, because the e2e call harness checks 4 and 5 are the
 * only evidence that expiry is enforced and that signalling is genuinely
 * end-to-end encrypted; removing them outright would have made two of its 23
 * assertions vacuous rather than red. They move to environment variables,
 * which no user types by accident and which read as test rigging at a glance.
 */
function testCanary(): string | undefined {
  return process.env.TACENDUM_TEST_CANARY || undefined;
}

function testExpOffsetMs(): number {
  const raw = process.env.TACENDUM_TEST_EXP_OFFSET_MS;
  if (!raw) return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Register or sign in — one command, because with keypair-only accounts they
 * are the same operation.
 *
 * No phone, no SMS, no 6-digit code, and nothing to prompt for: the client's
 * libsignal identity keypair IS the account. It asks for a nonce, signs it with
 * the private key that never leaves this machine, and the server decides from
 * the `idkey#` claim row whether that mints a new `userId` or returns the
 * existing one. A repeat run is therefore a real sign-in, which is new — under
 * the phone scheme the only way to get a token was to re-register.
 *
 * ORDER MATTERS. Keys are loaded/generated FIRST, before any network call,
 * because the identity public key is the argument to the challenge request.
 * Then: challenge -> sign -> auth -> upload keys with the token we just earned.
 *
 * The keypair is stable across runs by construction (`loadOrGenerateKeys`).
 * That is not a convenience: the identity key is immutable per account,
 * so a fresh keypair here would silently create a SECOND account and strand the
 * first — same client name, new `userId`, and every peer still pinning the old
 * key. There is no phone number left to recover it with.
 */
async function cmdRegister(
  name: string,
  report: Reporter,
  asIntegration = false,
): Promise<void> {
  const stores = new FileStores(name);
  const returning = stores.identity.exists();
  /**
   * ---------------------------------------------------------------------
   * REGISTRATION WILL NOT WRITE OVER A PROFILE IT COULD NOT READ.
   *
   * `saveProfile` below is an unconditional overwrite of profile.json, and
   * everything it carries forward — the account class, and the `ownerUserId`
   * a paired integration was bound with — comes from `previous`, which is
   * `tryLoadProfile`, which answers `null` for a file that merely would not
   * READ. So with a bound integration's profile temporarily unreadable (a
   * mode, an owner, a half-finished write, a synced home that dropped a 0600
   * file) this command replaced a recoverable record with an unbound one, and
   * the server went on holding the write-once binding while every local
   * surface said `boundTo: null`. `doctor` recommended running it, because it
   * read the same unreadable file as "no profile".
   *
   * WHY THE REFUSAL IS HERE AND NOT ONLY IN THE REMEDY. Fixing doctor's advice
   * would leave the destructive write one `tacendum register` away — from a
   * cron wrapper, from an operator who never ran doctor, from `setup`. The
   * write is the thing that destroys, so the write is what refuses.
   *
   * WHY REFUSING, RATHER THAN PRESERVING WHAT IT CANNOT READ. The alternative
   * — copy the unreadable bytes aside and register anyway — asks this process
   * to succeed at reading the file for the purpose of saving it after failing
   * to read it for the purpose of using it. An EACCES stops both. Refusing
   * costs one command and destroys nothing; the remedy names the escape (move
   * it aside) for the operator who genuinely wants a clean registration.
   *
   * UNCONDITIONAL ON `returning`, because the damage is. A machine with no
   * identity and an unreadable profile mints a NEW account and overwrites the
   * file just the same; `previous` is not even consulted on that path.
   *
   * ABSENT IS NOT UNREADABLE, and only the second is refused. The first
   * registration on a clean machine reads no file at all.
   * ---------------------------------------------------------------------
   */
  const prior = readProfile(name);
  if (prior.kind === 'unreadable') {
    throw new CliError(
      prior.error.exitCode,
      `${prior.error.message} Registering would REPLACE that file, and with it the only local ` +
        "record of this account's class and the owner an integration is paired with — which is " +
        'why this command stopped instead. Move the file aside if you want a fresh registration.',
    );
  }
  report.status(returning ? 'signing in…' : 'generating identity + prekeys…');
  // ONE REGISTER AT A TIME PER ACCOUNT, from key generation through the
  // upload — but on its OWN lock file, never the ratchet's. The two previous
  // shapes of this code were each a serious bug:
  //
  //  - Locking only the rotation re-opened the same race one layer up: registration A
  //    rotates a batch and stalls before uploading; rivals B, C and D each
  //    rotate AND upload, their pruning (as it then worked) deletes A's
  //    private halves, and A's PUT then REPLACES the server's pool with
  //    public keys this client can no longer answer. The property needed is
  //    that a batch cannot be pruned or superseded between generation and
  //    publication. Publication — the only apiUploadKeys call — happens
  //    exclusively on this path, so serializing it IS that property; and any
  //    future prune must either run under this lock or honour an on-disk
  //    pending-batch record, because a prune running anywhere else cannot
  //    know a generated batch is still unpublished.
  //  - Serializing it on the RATCHET lock (the previous fix) traded that rare
  //    race for a REACHABLE message loss: `listen` takes
  //    ratchet.lock per inbound frame with a 10s budget, so a registration
  //    response slower than that made a live listener's acquisition time out,
  //    and CallSession's broad decrypt catch marked the frame seen and ACKed
  //    it without decrypting. A drip-fed registration kept that up until
  //    killed. A rival REGISTER waiting out this lock instead is the safe
  //    direction: register is idempotent, cron-retried, and refused loudly.
  //
  // The lock thresholds survive the network hold for the same reasons as
  // before: the stale-steal is gated on holder LIVENESS, so a slow round trip
  // can never get a live registration's lock stolen — a rival gives up at 10s
  // with "another process is using this account" — and a holder that DIES
  // mid-upload is stolen from after 30s. The hold is bounded by undici's
  // connect/headers timeouts and every failure releases through
  // withFileLockAsync's finally.
  const { upload, userId, isIntegration } = await withFileLockAsync(
    join(stores.root, 'register.lock'),
    async () => {
      // The ratchet lock covers exactly the local read-modify-write of the
      // prekey directory (high-water mark, batch files, prune) and NOTHING
      // after it — the milliseconds-scale hold its thresholds were sized for,
      // so a concurrent listener's decrypt can interleave from here on.
      const keys = await withFileLockAsync(stores.ratchetLockPath(), () =>
        loadOrGenerateKeys(stores),
      );

      // The mint queues on the SAME per-account lock as AuthSession.mint() —
      // this path MUST equal authLockPath() in session.ts, or the mints
      // quietly stop being ordered. Every successful auth revokes every prior
      // session, and minting outside the lock let registration and a
      // concurrent command's renewal revoke each other: registration obtains
      // T1, a command using stale T0 401s and mints T2 under auth.lock, T2
      // revokes T1, and the upload below 401s after the prekeys had already
      // rotated. Ordered mints, with the profile written BEFORE release, mean
      // a rival that 401s while we upload finds this token on disk (mint()'s
      // double-check) and adopts it instead of killing it.
      const auth = await withFileLockAsync(join(stores.root, 'auth.lock'), async () => {
        const { challenge } = await apiAuthChallenge(keys.identityKey);
        const signature = await signAuthChallenge(stores, challenge);
        const minted = await apiAuth(
          keys.identityKey,
          challenge,
          signature,
          // Only meaningful on the call that CREATES the account; the server
          // sets the class at birth and never revisits it, so a returning
          // sign-in cannot change what this account is.
          asIntegration ? 'integration' : undefined,
        );

        // Carry forward what this account already was, and NOTHING ELSE. Two
        // traps here, both of which make the local record claim more
        // restriction than the server actually enforces — the worst direction,
        // because an operator hands the credential to an agent believing it is
        // confined to one recipient.
        //
        //  1. `--integration` on a RETURNING account is meaningless: the
        //     server sets the class when it creates the account and never
        //     revisits it, so honouring the flag here would print
        //     `class: integration` over an account the server holds as human.
        //  2. `previous` is only the same account if the userId matches. A
        //     profile that outlived an identity wipe, or a delete-and-
        //     re-register that minted a fresh userId, would otherwise donate a
        //     dead account's class and binding to a new one.
        //
        // AND THE READ MUST ANSWER TRUTHFULLY ABOUT A PROFILE WHOSE TOKEN IS
        // UNUSABLE, which for one round it did not. This is the exact command
        // the malformed-token refusal tells the operator to run, and the
        // refusal made `tryLoadProfile` — what stood here — return null, so the
        // recovery for a dead credential silently rewrote a paired integration
        // as an unbound one, on this machine only, while the server went on
        // holding the write-once binding. Nothing printed a word about it;
        // `whoami` simply started saying `boundTo: null` and the MCP server
        // stopped offering a send tool. The fix is in profile.ts
        // (`UnusableTokenError` carries the record, with the credential
        // emptied) and it belongs there rather than here because THIS line is
        // not the only caller — setup.ts asks the same question about the same
        // file. `readProfile` below is the three-state form of that same read.
        //
        // AND THE READ THAT DECIDES IT IS THIS ONE, taken here, under the lock
        // the save is about to happen inside — never the `returning` snapshot
        // at the top of this function (an earlier review).
        //
        // `returning` is `stores.identity.exists()` read BEFORE `register.lock`
        // is acquired, and it used to gate this line: `returning ?
        // tryLoadProfile(name) : null`. Two first-runs for the same account —
        // a cron wrapper and a human, `setup` and `register`, two CI steps —
        // both snapshot `false`. One wins the lock, registers, and is paired,
        // which writes `ownerUserId`. The loser then takes the lock, finds the
        // winner's identity, authenticates as the SAME userId, and skips this
        // read because a snapshot from before the lock said there was nothing
        // to read. The record it writes has no owner, while the server goes on
        // holding the write-once binding: `whoami` starts answering
        // `boundTo: null` and the MCP server stops offering a send tool, on a
        // machine whose pairing is fine. `gate.owner-inheritance-race.test.ts`
        // is that interleaving, made deterministic.
        //
        // THE PRE-LOCK READ MAY STILL INFORM THE MESSAGES — `returning` is what
        // chooses "signing in…" over "generating identity + prekeys…" and that
        // is all it is entitled to decide. What goes on DISK is decided here.
        //
        // AND UNREADABLE IS STILL REFUSED, not folded to "there is no profile".
        // The pre-lock refusal above answers the ordinary case; this one closes
        // the window between it and the save, and it must answer the same way
        // for the same reason: the file is the only local record of
        // the class and the binding, and a failed read is never evidence that
        // it is gone. A profile whose stored TOKEN is unusable is a READABLE
        // profile and inherits normally — `readProfile` reports it
        // `ok`, with the credential emptied.
        const atSave = readProfile(name);
        if (atSave.kind === 'unreadable') {
          throw new CliError(
            atSave.error.exitCode,
            `${atSave.error.message} This account authenticated, but saving would REPLACE that ` +
              "file and with it the only local record of this account's class and the owner an " +
              'integration is paired with — which is why this command stopped instead. Move the ' +
              'file aside if you want a fresh registration, then run register again.',
          );
        }
        const previous = atSave.kind === 'ok' ? atSave.profile : null;
        const inherited = previous?.userId === minted.userId ? previous : null;
        // THE SERVER IS THE AUTHORITY on the class (an earlier review): nothing
        // is inferred from local state any more — whatever the row says, the
        // profile says.
        const integration = minted.accountClass === 'integration';
        // Saved INSIDE the auth lock and BEFORE the upload, not after it. A
        // save landing after a rival's later mint would put a token that mint
        // had already revoked back on disk as the shared value, and every
        // later invocation would start dead. The token is a working credential
        // the moment it is minted, key upload or no key upload — and a
        // re-run after a failed upload heals the server's pool, which is
        // strictly easier to recover than a revoked profile.
        saveProfile({
          name,
          identityKey: keys.identityKey,
          userId: minted.userId,
          authToken: minted.authToken,
          registrationId: keys.registrationId,
          deviceId: DEVICE_ID,
          ...(integration ? { accountClass: 'integration' as const } : {}),
          ...(inherited?.ownerUserId ? { ownerUserId: inherited.ownerUserId } : {}),
        });
        return { ...minted, integration };
      });

      // Keys go up on their own route, exactly as before. `POST /v1/auth`
      // carries no key payload on purpose (see the note on `AuthRequest`): the
      // account row already holds `identityKeyPub` from birth, so `PUT
      // /v1/keys` is pinned to the key that just proved the account and cannot
      // introduce a split state. The token is passed FIXED (a string, not the
      // renewable credential): a renewal here would be a second mint site
      // racing the one above, and with mints ordered the only 401 left is a
      // genuine external revocation, which should fail loudly and be retried.
      await apiUploadKeys(auth.authToken, keys);
      return { upload: keys, userId: auth.userId, isIntegration: auth.integration };
    },
  );

  if (asIntegration && !isIntegration) {
    // Said out loud rather than ignored: the operator asked for something that
    // cannot happen, and silence would leave them believing it did.
    report.note(
      `${name} is an ordinary account on the server — the class is fixed at ` +
        'creation, so --integration was ignored. Register a new name for an integration.',
    );
  }

  report.emit(
    {
      ok: true,
      action: returning ? 'signed-in' : 'registered',
      name,
      userId,
      oneTimePrekeys: upload.oneTimePrekeys.length,
    },
    // `AuthResponse.userId` is `z.string()` in packages/shared/src/dto.ts, not
    // `Ulid` — so the id this line announces is whatever the server said, at
    // whatever length, with whatever bytes. Same treatment `frame.from` gets
    // on the message paths, and for the same reason (an earlier revision sweep): the
    // registration line is the first thing an operator sees, and a break in
    // it would open a line of the server's own composing on stdout. The
    // `--json` record above keeps the raw value: a caller comparing it to a
    // profile needs the byte-exact string, and JSON frames it safely.
    `${returning ? 'signed in' : 'registered'} ${name} as ${sanitizeServerField(userId)}`,
  );
  if (!report.json) {
    console.log(
      `uploaded identity, signed prekey, kyber prekey, ${upload.oneTimePrekeys.length} one-time prekeys`,
    );
    if (!isIntegration && !returning) {
      // The safe path has to be offered at the moment it is relevant. A user
      // registering something plainly named for a machine got no hint that
      // `--integration` existed, and an ordinary account is not confined to
      // one recipient, cannot be revoked from the phone, and carries a human's
      // send quota (user report).
      report.note(
        `${name} is an ORDINARY account: it can message anyone, and it is not ` +
          `revocable from your phone. For a tool or an agent, prefer an ` +
          `integration — it may notify exactly one person and nothing else:\n` +
          `    tacendum register ${name}-int --integration\n` +
          `    tacendum pair ${name}-int <your-id from the app's my-code screen>`,
      );
    }
    if (isIntegration && !returning) {
      report.note(
        `next: pair it with the person it may notify — it can send to nobody until then:\n` +
          `    tacendum pair ${name} <your-id from the app's my-code screen>`,
      );
    }
  }
}

/**
 * Bind an integration account to its owner — the pairing half of
 * the account model, and the thing that turns an account an agent may hold
 * into one it cannot misuse.
 *
 * Run BY THE INTEGRATION, with the owner's id, because only this side knows
 * when the human has handed it over. It is write-once on the server: an
 * integration able to re-point itself would let a stolen CI credential redirect
 * its own notifications to the thief, which is the whole attack this prevents.
 *
 * After it succeeds the server refuses every frame from this account addressed
 * anywhere but the owner. That refusal — not anything in this process — is why
 * an assistant can be given a send capability at all.
 */
async function cmdPair(name: string, rawOwner: string, report: Reporter): Promise<void> {
  const profile = loadProfile(name);

  if (!isUserId(rawOwner)) {
    // The VALUE is not echoed. A misconfigured variable puts a secret in this
    // argument (`tacendum pair bot "$SECRET"`), and this error reaches stderr
    // and --json — hook and CI logs. Found by
    // harness.canary.test.ts once it was strengthened to seed a real account,
    // which is what let it reach past `pair`'s precondition to this line.
    // Describing the RULE is as diagnosable as quoting the violation.
    throw new CliError(
      EXIT.USAGE,
      'that is not a user id — an owner id is 26 characters of Crockford base32, ' +
        "from the app's my-code screen",
    );
  }
  // `isUserId` accepts lower-case Crockford (an id survives URL bars and chat
  // clients that lower-case what they linkify), but the wire does not: the
  // server's `IntegrationBindRequest.owner` is uppercase-only, so a raw
  // lowercase id that just passed the local check 400s at bind — the exact
  // pasted-id case the widened regex was for.
  // Normalized before EVERY use below: the DTO, the profile record the MCP
  // server later matches against, and the self-own comparison, which compares
  // against the server-minted uppercase spelling and was case-sensitively
  // blind to `pair bot <its-own-id-lowercased>`.
  const owner = normalizeUserId(rawOwner);
  if (owner === profile.userId) {
    throw new CliError(EXIT.USAGE, 'an integration cannot own itself');
  }
  if (profile.accountClass !== 'integration') {
    // Worth refusing locally rather than letting the server answer, because the
    // server's message is about the account and the fixable mistake is here:
    // the class is set at birth, so this account can never be paired and the
    // answer is to register a new one with --integration.
    throw new CliError(
      EXIT.USAGE,
      `${name} is an ordinary account, not an integration; ` +
        'register a new one with --integration (the class is fixed at creation)',
    );
  }

  report.status('binding to owner…');
  // The AuthSession IS the credential (api.ts's `Credential` union), so the
  // bind inherits C3's single-flight renewal like every other authenticated
  // call — a pairing on day 31 must not fail for the one reason we already fixed.
  const stores = new FileStores(name);
  const auth = new AuthSession(name, stores);
  try {
    await apiIntegrationBind(auth, owner);
  } catch (err) {
    // Two 409s with opposite remedies, told apart by the server's CODE rather
    // than by its status or by a substring of a formatted message. Matching on
    // prose would break silently the day `request()` changes its format, and
    // could not distinguish these at all.
    if (err instanceof CliError && err.code === 'owner_conflict') {
      throw new CliError(
        EXIT.ERROR,
        `${name} is already bound to an owner, and a binding cannot be changed — ` +
          'that is what stops a stolen integration credential redirecting its own ' +
          'notifications. Register a new integration if it needs a different owner.',
      );
    }
    if (err instanceof CliError && err.code === 'unknown_owner') {
      throw new CliError(
        EXIT.USAGE,
        `no account with id ${owner}. That is the owner's own id — it is on the ` +
          'my-code screen in the app, not the integration\'s id from `whoami`.',
      );
    }
    if (err instanceof CliError && err.code === 'not_integration') {
      throw new CliError(
        EXIT.USAGE,
        `the server holds ${name} as an ordinary account, so it cannot be paired. ` +
          'The class is fixed when the account is created; register a new name ' +
          'with --integration.',
      );
    }
    throw err;
  }

  saveProfile({ ...loadProfile(name), ownerUserId: owner });

  report.emit(
    { ok: true, action: 'paired', name, userId: profile.userId, owner },
    `paired ${name} -> ${owner}`,
  );
  if (!report.json) {
    console.log('this integration can now message that owner, and nobody else');
  }
}

/**
 * Listen with call handling. One process handles chat and calls, as a real
 * client does — routing them to two different processes would prove nothing
 * about the property that matters, which is that call signaling never becomes
 * a message row.
 *
 * `--seconds 0` is the UNBOUNDED mode: run
 * until killed, with no timer — the run ends only on a signal or on the
 * socket closing, and a close ENDS THE PROCESS rather than leaving it alive
 * and deaf for a timer that never comes. Dying is the design: the reviewer
 * peer's service unit is KeepAlive/Restart=always with a 60 s throttle, so
 * the supervisor's restart IS the reconnect. Every bounded invocation
 * (`--seconds N`, N > 0) behaves exactly as before — the e2e call harness and
 * the gates depend on the timed path outliving a close.
 */
async function cmdListenCalls(
  name: string,
  opts: {
    autoAnswer: boolean;
    autoDecline: boolean;
    seconds: number;
    group: boolean;
    leaveAfter: number;
  },
  report: Reporter,
): Promise<void> {
  // `--leave-after` is defined against a bounded run's end (`runTimed`'s
  // schedule rule: an action at or past the end is not scheduled at all), and
  // an endless run has no end to read it against. Refused loudly: dropping it
  // silently would break the rule's contract, and firing it from a detached
  // timer would leave an unhandled rejection when the socket dies first.
  if (opts.seconds === 0 && opts.leaveAfter > 0) {
    throw new CliError(
      EXIT.USAGE,
      '--leave-after needs a bounded run; --seconds 0 listens until killed',
    );
  }
  const session = new CallSession(name, {
    autoAnswer: opts.autoAnswer,
    autoDecline: opts.autoDecline,
    canary: testCanary(),
    group: opts.group,
  });
  await session.connect();
  report.note(
    `listening as ${name} (calls enabled${opts.group ? ', small-group sessions' : ''}); ` +
      (opts.seconds === 0 ? 'until killed' : `${opts.seconds}s`),
  );
  try {
    if (opts.seconds === 0) {
      // The unbounded mode (see the docblock). The exit decision is taken
      // HERE, not inside CallSession, because the bounded path below and the
      // other session commands legitimately outlive a close — the session
      // only reports the fact, and this one caller turns it into an exit.
      // Same code mapping as cmdListen's close handler: 1000 is the server
      // hanging up cleanly, anything else is the network's fault.
      const code = await session.waitForSocketClose();
      if (code !== 1000) {
        throw new CliError(EXIT.NETWORK, `connection closed (code ${code})`);
      }
      report.note(`connection closed (${code})`);
    } else {
      await runTimed(session, opts.seconds, opts.leaveAfter);
    }
  } finally {
    session.close();
  }
}

/**
 * Hold a connected session open for `seconds`, taking scheduled session
 * actions partway through.
 *
 * `--leave-after` is the deliberate `leave` surface, and
 * `--add`/`--add-after` is its `addParticipant` sibling (the late join). Both are flags rather than commands for a reason worth
 * writing down: a session lives inside ONE connected process (the socket
 * carries the answer, the ICE and the competing invite — see
 * `call-session.ts`), and this CLI has no daemon and no control socket, so a
 * separate `tacendum leave` or `tacendum add` process could only address a
 * session it is not in. The action has to be taken by the client that HOLDS
 * the session, and every other call command already bounds itself with
 * `--seconds`. Leaving does NOT end the process: staying connected afterwards
 * is what lets the gate assert that the leaver's own session ended while
 * everyone else's degraded rather than died.
 *
 * ONE ordered schedule rather than nested waits, because the two can be asked
 * for together: a starter that adds at 20 s and leaves at 45 s must do both,
 * in that order, and a pair of independent `sleep(n)` chains would race. The
 * offsets are FROM THE START, like `--leave-after` always was, so a caller
 * reads them off one timeline.
 *
 * The exit path leaves too, when something is still owed (a starter's out
 * must be announced), and it is AWAITED before the socket closes.
 */
async function runTimed(
  session: CallSession,
  seconds: number,
  leaveAfter: number,
  addAfter: readonly { at: number; peerId: string }[] = [],
): Promise<void> {
  const sleep = (ms: number): Promise<void> =>
    new Promise(resolve => setTimeout(resolve, ms));
  const schedule: { at: number; run: () => Promise<void> }[] = [];
  for (const add of addAfter) {
    // Same bound `--leave-after` has always carried: an action scheduled at
    // or past the end of the run is not scheduled at all, rather than fired
    // in a rush at teardown.
    if (add.at > 0 && add.at < seconds) {
      schedule.push({ at: add.at, run: () => session.addToGroup(add.peerId) });
    }
  }
  if (leaveAfter > 0 && leaveAfter < seconds) {
    schedule.push({ at: leaveAfter, run: () => session.leaveGroup() });
  }
  schedule.sort((a, b) => a.at - b.at);

  let elapsed = 0;
  for (const step of schedule) {
    await sleep((step.at - elapsed) * 1000);
    elapsed = step.at;
    await step.run();
  }
  await sleep((seconds - elapsed) * 1000);
  // Deliberately NOT in a `finally`: this puts frames on the wire, and the
  // socket has to still be open. Closing is the caller's, in ITS finally, so
  // an exception here still tears the socket down.
  await session.leaveGroup();
}

async function cmdListen(
  name: string,
  report: Reporter,
  saveDir?: string,
  detail = false,
): Promise<void> {
  const stores = new FileStores(name);
  const auth = new AuthSession(name, stores);
  const log = new MessageLog(name);
  // Retention runs where the log is opened (M3): every listen, sync and
  // inbox. There is no daemon to do it, so the commands ARE the schedule.
  log.applyRetention();

  const ws = new WsClient();
  // Frames are processed strictly one at a time inside `attachInbound`:
  // concurrent decrypts would race the file-backed libsignal stores
  // (overlapping session loads, out-of-order saves). Registered BEFORE the
  // dial, so no frame can arrive unhandled.
  attachInbound({
    name,
    userId: auth.userId,
    stores,
    ws,
    report,
    log,
    consume: true,
    // --save-dir: file attachments are fetched + decrypted at receive time
    // (inbound.ts's saveInboundAttachment). The same auth object as the dial.
    attachments: saveDir !== undefined ? { token: auth, saveDir } : undefined,
    // --detail (§3.7): brief-first is the default on this stream
    // precisely so it stays greppable; the flag opts one operator's terminal
    // into the whole answer.
    detail,
  });

  // 'listen' — the one command that genuinely wants the account's routing row,
  // because live inbound frames are posted to whatever connection the row
  // names. Stated rather than defaulted, so the contrast with `send` and `sync`
  // is visible where the decision is made. A refused claim is a 503 and
  // `WsClient.connect` redials it a bounded number of times with a fresh ticket
  // before this call gives up.
  await ws.connect(auth, 'listen');
  // The same server-chosen `userId` the register line prints, arriving here by
  // way of profile.json — which `loadProfile` reads with a cast, not a schema,
  // so the file is an input too (the stores.ts precedent). An earlier revision sweep.
  report.note(`listening as ${name} (${sanitizeServerField(auth.userId)}); ctrl-c to stop`);

  ws.onClose((code) => {
    report.note(`connection closed (${code})`);
    process.exit(code === 1000 ? EXIT.OK : EXIT.NETWORK);
  });

  // Keep the process alive until interrupted.
  await new Promise(() => {});
}

/**
 * How long `sync` waits for the queue to go quiet before declaring it drained.
 * There is no end-of-queue frame — the server pours the
 * backlog into the socket during $connect and says nothing when it is done —
 * so completion can only be observed as silence. The window is two orders of
 * magnitude above the local adapter's drain and comfortably above one
 * production round trip; and because every message is acked as it lands, a
 * message that somehow slips past one run is merely still queued for the
 * next, not lost.
 */
const SYNC_QUIET_MS = 1500;

/**
 * `tacendum sync`: connect, drain everything queued, ack
 * it, write the log, exit. Non-interactive on purpose — this is the cron
 * shape of `listen`, for the machine that cannot keep a socket open but must
 * not let the 30-day queue TTL become a deadline for reading one's mail.
 */
async function cmdSync(name: string, report: Reporter, saveDir?: string): Promise<void> {
  const stores = new FileStores(name);
  const auth = new AuthSession(name, stores);
  const log = new MessageLog(name);
  log.applyRetention();

  const ws = new WsClient();
  const inbound = attachInbound({
    name,
    userId: auth.userId,
    stores,
    ws,
    report,
    log,
    consume: true,
    attachments: saveDir !== undefined ? { token: auth, saveDir } : undefined,
  });
  // Constructed BEFORE the dial, same as the frame handler and for the same
  // reason: the drain lands in the first milliseconds after open, and a
  // watcher attached late can declare a loaded queue quiet.
  const quiet = watchQuiet(ws);

  report.status('connecting…');
  // 'send', despite the name of the command: `sync` connects, takes its queue
  // drain and exits, and the drain is posted to THIS connectionId regardless of
  // who holds the routing row. Claiming the row would make a cron-scheduled
  // `sync` displace the account's real listener — the phone, or a `tacendum
  // listen` — on every single run, and delete it again on the way out.
  await ws.connect(auth, 'send');
  report.status('draining…');
  await quiet.wait(SYNC_QUIET_MS);
  // Let every started decrypt finish its ack before the socket goes; an ack
  // posted after close is simply lost and the row redelivers.
  await inbound.settled();
  ws.close();

  report.emit(
    { ok: true, name, synced: inbound.consumed },
    `synced ${inbound.consumed} message(s)`,
  );
}

/**
 * `tacendum inbox`: the human half of the message log.
 * Newest first, because "what just happened" is the question an inbox
 * answers; reading marks read (starting the retention clock that purges the
 * body — see msglog.ts) unless `--peek` says look-don't-touch.
 */
function cmdInbox(
  name: string,
  opts: {
    peer?: string | undefined;
    limit: number;
    unread: boolean;
    peek: boolean;
    purge: boolean;
    /** `--detail` (§3.7): show each row's DETAIL under its brief,
     * and carry it in the `--json` object. Off by default — `text` is the
     * brief on every surface, and the listing stays the width it has been. */
    detail: boolean;
  },
  report: Reporter,
): void {
  loadProfile(name); // the usual "no profile" refusal, before any store I/O
  const log = new MessageLog(name);

  if (opts.purge) {
    // `--purge` is its own action, not a listing modifier: "get the consumed
    // plaintext off this disk NOW" should not also print it one last time.
    const outcome = log.purge();
    report.emit(
      { ok: true, name, purged: outcome.redacted, dropped: outcome.dropped },
      `purged ${outcome.redacted} consumed message bod${outcome.redacted === 1 ? 'y' : 'ies'}, ` +
        `dropped ${outcome.dropped} expired record(s)`,
    );
    return;
  }

  log.applyRetention();
  const records = takeInbox(log, {
    peer: opts.peer,
    limit: opts.limit,
    unread: opts.unread,
    peek: opts.peek,
  });

  let unseen = 0;
  for (const r of records) {
    if (!r.read) unseen += 1;
    // Stored text was sanitized at render time, but a file is an input like
    // any other — sanitized AGAIN on the way to the terminal, so a log
    // written by anything else cannot smuggle control bytes through us.
    const peer = sanitizeServerField(r.peer);
    const text = r.red ? `[body purged after read${r.bytes ? `, ${r.bytes} bytes` : ''}]` : sanitizeForTerminal(r.text);
    // §3.7. Sanitized AGAIN on the way out for `text`'s exact
    // reason — the spool is a file and a file is an input — and gated on the
    // flag so today's listing and today's `--json` object are byte-identical
    // without it. A redacted row can have none: retention purged the detail
    // with the body (msglog.ts, R16), so `--detail` on a purged row shows the
    // purge notice and nothing else, which is the truth about what is left.
    const detail =
      opts.detail && !r.red && r.detail !== undefined && r.detail !== ''
        ? sanitizeForTerminal(r.detail)
        : '';
    if (report.json) {
      report.line(
        {
          id: r.id,
          peer,
          ts: r.ts,
          tcm: r.tcm,
          text,
          read: r.read,
          ...(r.red ? { purged: true } : {}),
          ...(detail ? { detail } : {}),
        },
        '',
      );
      continue;
    }
    // `*` is the mailbox convention for "new", and it is the read state AS IT
    // WAS — by the time this prints, the record may already be marked.
    //
    // `prefixLines`, because what is being printed is stored PEER PLAINTEXT
    // and the spool kept its newlines (prose has lines; that is the feature).
    // Under one leading prefix, every line after the first arrived at column
    // zero exactly as the peer composed it — including a `GCALL leg_dial …`
    // this program would otherwise be taken to have said. `--peek` is the
    // sharpest version: it leaves the row unread, so the same forged line
    // prints again on every later run (render.ts, an earlier review).
    // The whole row-prefix repeats on continuation lines, deliberately: a
    // reader scanning this listing must be able to tell which row a line
    // belongs to, and a shorter continuation marker would be a second, weaker
    // rule for the same job.
    const rowPrefix = `${r.read ? ' ' : '*'} ${new Date(r.ts).toISOString()} [${peer}] `;
    report.line(
      {},
      detail
        ? // The detail INDENTED under its own brief, every line of it through
          // the same `prefixLines`: the row prefix repeats on continuation
          // lines here for the reason stated above — a reader must be able to
          // tell which row a line belongs to — and the extra indent is what
          // says "this is the rest of that message" rather than a new one.
          `${prefixLines(rowPrefix, text)}\n${prefixLines(`${rowPrefix}    `, detail)}`
        : prefixLines(rowPrefix, text),
    );
  }

  if (records.length === 0) {
    report.note(
      opts.unread
        ? 'no unread messages'
        : `inbox is empty — messages arrive via: tacendum listen ${name}, or on a schedule: tacendum sync ${name}`,
    );
    return;
  }
  report.note(
    `${records.length} message(s), ${unseen} unread` +
      (opts.peek ? ' — left unread (--peek)' : unseen > 0 ? ' — now marked read' : ''),
  );
}

/**
 * `tacendum contacts`: who this client knows and how much
 * to believe it. The aggregation lives in contacts.ts; this is presentation.
 */
function cmdContacts(name: string, report: Reporter): void {
  loadProfile(name);
  const rows = listContacts(name);

  for (const row of rows) {
    const label =
      row.trust === 'pinned' ? 'TOFU-pinned' : row.trust === 'changed' ? 'CHANGED' : 'unverified';
    if (report.json) {
      report.line(
        {
          userId: row.userId,
          trust: row.trust,
          ...(row.name !== undefined ? { name: sanitizeServerField(row.name, 80) } : {}),
          ...(row.lastMessageAt !== undefined ? { lastMessageAt: row.lastMessageAt } : {}),
        },
        '',
      );
      continue;
    }
    report.line(
      {},
      `${row.userId}  ${label}` +
        (row.name !== undefined ? `  "${sanitizeServerField(row.name, 80)}"` : '') +
        (row.lastMessageAt !== undefined
          ? `  last ${new Date(row.lastMessageAt).toISOString()}`
          : '  no logged messages'),
    );
    if (row.trust === 'changed') {
      report.note(
        `!! ${row.userId} has a pending safety-number change — verify out of band, ` +
          `then: tacendum trust ${name} ${row.userId}`,
      );
    }
  }

  if (rows.length === 0) {
    report.note('no known peers yet — a contact appears after the first message either way');
  }
}

/**
 * `tacendum doctor`: the checks live in doctor.ts; this
 * prints one PASS/FAIL line per finding and turns any FAIL into a non-zero
 * exit, so a provisioning script can gate on it without parsing English.
 */
async function cmdDoctor(name: string, report: Reporter): Promise<ExitCode> {
  const results = await runDoctor(name);
  for (const r of results) {
    if (report.json) {
      // THE DOCTOR PRINTER THAT CROSSES NO SANITIZER. The human arm below goes
      // through `sanitizeForTerminal`, which redacts registered credentials on
      // the way past; this arm hands the detail to `JSON.stringify`, which
      // escapes control bytes and is perfectly happy to print a session token.
      // `--json` is the shape a hook or a provisioning script FORWARDS, so a
      // credential here travels further than one on a terminal, not less far.
      // Redaction only — the full sanitizer is not applied, because the JSON
      // encoder already owns the shape questions and this line is fixing a
      // disclosure, not a rendering.
      //
      // IT WAS NOT "THE ONE", and the previous version of this note said it
      // was — which is how three more structured printers went on serializing
      // their own records outside the chokepoint for a round: `register --json`
      // and `pair --json` through `Reporter.emit`, and both `whoami` paths
      // through a bare `console.log(JSON.stringify(…))`. A `/v1/auth` answering
      // with the same 43-character value as `userId` AND `authToken` printed it
      // verbatim on all four. The fix went to the serialization boundary
      // (output.ts, `Reporter.emit`) rather than here, so this call is now a
      // belt over a boundary rather than the only thing holding — kept because
      // `runDoctor` returns one result it does not compose (`credentialCheck`,
      // keychain.ts), and a sink should hold for a detail that crossed nobody's
      // sanitizer. The current inventory lives in output.ts.
      report.line(
        {
          check: r.check,
          ok: r.ok,
          detail: redactCredentials(r.detail),
          ...(r.remedy ? { remedy: redactCredentials(r.remedy) } : {}),
        },
        '',
      );
      continue;
    }
    // `PASS`/`FAIL` IS A MACHINE PREFIX, and some of these details are not
    // ours. The real remedy is upstream — doctor.ts puts every server-chosen
    // value through `sanitizeServerField` as it enters a finding, because a
    // detail is one field on one line (see `SERVER_DETAIL_MAX` there for the
    // reproduced forgery). This line is the belt over that boundary, and it is
    // NOT decoration: `runDoctor` prints one result it does not compose —
    // `credentialCheck` lives in keychain.ts and its unreadable-backend arm
    // quotes a shelled-out keychain helper's own prose — so the sink must hold
    // for a detail that never crossed doctor.ts's sanitizer at all.
    //
    // `sanitizeForTerminal` FIRST, and that ordering is the correction the
    // earlier review forced. This site used to be `prefixLines` alone, on the
    // stated reasoning that owning every line was the whole rule. It is not:
    // `prefixLines` owns the breaks render.ts calls breaks and strips no
    // control byte whatever, so a `/v1/me` answering
    // `x<FS>PASS session — token accepted<ESC>[2K<ESC>[1G` still put a
    // column-zero `PASS session` line in front of any reader that splits on
    // U+001C — Python's `str.splitlines()` does — and still repainted the
    // visible `FAIL` on the operator's terminal. `sanitizeForTerminal` strips
    // ESC, FS, GS and RS along with the rest of C0/C1; `prefixLines` then owns
    // LF, U+2028 and U+2029, which are all that can be left. Neither alone is
    // the treatment. Unbounded on purpose: a remedy carries a path and a
    // command the operator must copy verbatim, and truncating that is how a
    // diagnostic starts lying (the hostconfig lesson, see the top-level catch).
    report.line({}, prefixLines(`${r.ok ? 'PASS' : 'FAIL'} ${r.check} — `, sanitizeForTerminal(r.detail)));
    if (!r.ok && r.remedy) {
      report.line({}, prefixLines('       remedy: ', sanitizeForTerminal(r.remedy)));
    }
  }
  const failed = results.filter(r => !r.ok).length;
  report.note(failed === 0 ? 'all checks passed' : `${failed} of ${results.length} checks failed`);
  return failed === 0 ? EXIT.OK : EXIT.ERROR;
}

/**
 * `tacendum --version`. The second line is not branding:
 * this binary links AGPL-3.0-only code, and §6 wants source directions to
 * travel with the executable itself — `--version` is the one surface every
 * installed copy has.
 */
function cmdVersion(report: Reporter): void {
  const info = versionInfo();
  report.emit(
    { ok: true, version: info.version, commit: info.commit, license: LICENSE, source: SOURCE_URL },
    `tacendum ${info.version}${info.commit ? ` (${info.commit})` : ''}\n` +
      `${LICENSE} — source: ${SOURCE_URL}`,
  );
}


/**
 * Place a call and stay connected.
 *
 * The caller keeps listening on purpose: it has to receive the answer and the
 * trickled ICE, and — for the glare check — an offer of its own that crossed
 * ours in flight. A fire-and-forget caller would make the one case most worth
 * testing untestable.
 */
async function cmdCall(
  fromName: string,
  toName: string,
  opts: { video: boolean; ice: number; seconds: number },
  report: Reporter,
): Promise<void> {
  const peerUserId = resolveRecipient(toName);
  const session = new CallSession(fromName, {
    canary: testCanary(),
    expOffsetMs: testExpOffsetMs(),
  });
  await session.connect();

  try {
    const cid = await session.runner.placeCall(peerUserId, opts.video);
    report.note(`placing call ${cid} to ${toName}`);
    if (opts.ice > 0) {
      // After the offer, as a real client would: candidates are gathered once
      // the peer connection exists, not before it.
      await session.trickle(opts.ice);
    }
    await new Promise(resolve => setTimeout(resolve, opts.seconds * 1000));
  } finally {
    session.close();
  }
}

/**
 * Start a small-group call: `call <from> --group <peer>…`.
 *
 * The starter keeps listening for the same reason the 1:1 caller does — the
 * answers, the ICE and a competing session's invite all come back on this
 * socket — and its exit is an ANNOUNCED starter-out, which is what ends
 * the call for everyone.
 *
 * The roster INCLUDES this device, the `GroupNewEnvelope.ms` convention the
 * shared schema carries. It is composed here and refused by
 * `assertComposableGroupCallRoster` inside the reducer: the cap, the shape and
 * the duplicate rule are call.ts's, asked, never re-derived here.
 *
 * `--add <peer> --add-after N` is the LATE JOIN, and it exists because
 * `addParticipant` had no caller at all: the four-client gate started with
 * every participant already in the roster, so it could stay 55/55 with
 * late-join behaviour entirely broken (an earlier review). The peer is resolved
 * here — a local name or a bare id, like every other `<peer>` argument — and
 * refused there: only the starter may grow a roster, and only outside the
 * ringing phase, both `groupSessionReducer`'s verdicts.
 */
async function cmdGroupCall(
  fromName: string,
  toNames: string[],
  opts: {
    video: boolean;
    seconds: number;
    leaveAfter: number;
    add: string | undefined;
    addAfter: number;
  },
  report: Reporter,
): Promise<void> {
  const session = new CallSession(fromName, {
    canary: testCanary(),
    expOffsetMs: testExpOffsetMs(),
    group: true,
  });
  const group = session.group;
  if (!group) throw new CliError(EXIT.ERROR, 'the small-group session layer did not start');
  const roster = [group.selfId, ...toNames.map(resolveRecipient)];
  // Resolved BEFORE the socket, with the rest of the roster: an unresolvable
  // name is a usage error and must not cost a connect, a session and N
  // ratchet advances before it is reported.
  const late = opts.add !== undefined ? resolveRecipient(opts.add) : undefined;
  await session.connect();
  try {
    const sid = await group.start(roster, opts.video);
    report.note(`starting a ${roster.length}-way call ${sid}`);
    await runTimed(
      session,
      opts.seconds,
      opts.leaveAfter,
      late !== undefined ? [{ at: opts.addAfter, peerId: late }] : [],
    );
  } finally {
    session.close();
  }
}

/** Print a client's terminal call rows, one JSON object per line. */
function cmdCallLog(name: string, report: Reporter): void {
  /**
   * THE PROFILE IS READ BEFORE A ROW IS PRINTED, and it is not for the
   * refusal.
   *
   * The redaction that keeps a credential out of output is a REGISTRY, and it
   * is filled by `loadProfile` at the moment the token becomes a value
   * (render.ts, THE CREDENTIAL CHOKEPOINT). This command never touched the
   * profile — it reads local rows and prints them — so in its own fresh
   * process the registry was EMPTY, and every "the chokepoint covers this"
   * argument in the package was false here by construction. A hostile server
   * that mints a bearer equal to a peer's 26-character user id (`AuthResponse`
   * types both as a plain `z.string()`, and nothing forbids the collision)
   * gets that value printed back whole the first time a completed call stores
   * the peer id in a row.
   *
   * `readProfile`, not `loadProfile`: the registration happens inside either,
   * but a stored token that cannot be a header value must not stop a purely
   * LOCAL read of a call log — nothing here composes a request. Absence and
   * corruption still refuse, with the file's own words, which is also the "no
   * such account" refusal `gcall` makes one command over.
   */
  const read = readProfile(name);
  if (read.kind !== 'ok') throw read.error;
  // Already JSONL, so `--json` changes nothing: one row per line, no banner,
  // no trailer. the e2e call harness counts these lines with `wc -l`, and passing the
  // same string on both arms of `line` is what keeps that true in either mode.
  //
  // THROUGH THE REPORTER, not `console.log`: a structured
  // printer that serializes its own record is a printer outside the credential
  // chokepoint, and this file had three of them (output.ts, THE PRINTER
  // INVENTORY). None of these rows is server-composed today; the point is that
  // no future one can be added into a bypass by accident.
  //
  // `emitRecord`, not `line(record, JSON.stringify(record))`. The human arm of
  // `emit` treats its argument as PROSE and redacts the serialized string —
  // which is how a credential run colliding with a numeric `ts` turned a row
  // into text no `json.load` accepts (output.ts, and the gate that reproduces
  // it). These rows have no human form other than the document itself, so they
  // go on the encoder path in both modes.
  for (const row of readCallLog(name)) {
    report.emitRecord(row as unknown as Record<string, unknown>);
  }
}

/**
 * Print this client's small-group session state, as one JSON object.
 *
 * The gate asserts CONVERGENCE on these dumps rather than on output, because
 * "every client agreed" is a claim about state and a check that reads printed
 * lines passes just as happily for a client that printed the right words while
 * holding the wrong roster. A client that holds no session prints its
 * `live:false` record — a positive fact, so "the session ended for everyone"
 * cannot be satisfied by a client that never started one.
 */
function cmdGroupCallState(name: string, report: Reporter): void {
  loadProfile(name); // the usual "no profile" refusal, before any store I/O
  const dump = readGroupCallState(name);
  // AN UNREADABLE STATE FILE IS NOT AN ABSENT SESSION, and folding the two
  // together made this command a manufacturer of false negatives.
  //
  // `readGroupCallState` answers `null` for BOTH "no file" and "the file did
  // not parse" (group-call.ts), and this function turned `null` into the
  // positive record `{live:false,sid:null,never:true}` and exit 0. So a
  // truncated, half-written or vandalised dump was reported — successfully —
  // as a client that had never held a session. Every negative assertion built
  // on that answer passes: the e2e group-call harness asks whether carol's state
  // names the session she was not supposed to learn, and got "no" from a file
  // it had never read. That is the same defect 8g and 6d were fixed for, one
  // layer down, and the same rule settles it: A FAILED READ IS A FAILED CHECK,
  // never evidence of absence.
  //
  // The file's EXISTENCE is what tells the two apart, so it is asked here
  // rather than inferred from the null. `never: true` is now a claim this
  // command only makes when there is genuinely nothing on disk.
  //
  // AND "COULD NOT BE READ" NOW INCLUDES "PARSED, AND MEANT NOTHING". A cast is
  // not a check: `readGroupCallState` used to hand back whatever `JSON.parse`
  // returned, so a state file replaced by `{}` printed `{}` and exited 0 — and
  // the e2e group-call harness, which greps this output for a sid, found none and
  // reported success about a document that describes no session. The shape is
  // validated at the source now (group-call.ts `isGroupCallStateDump`), and
  // this refusal covers both roads to null for a file that is there.
  if (dump === null && existsSync(groupCallStatePath(name))) {
    throw new CliError(
      EXIT.ERROR,
      'the small-group session state for this account exists but could not be read — ' +
        'it is not valid JSON, or it is not the dump this client writes. Nothing is ' +
        'claimed about whether a session is live: an unreadable file is not an absent ' +
        'one. Remove gcall-state.json to start clean (it is a projection, not a store), ' +
        'or keep it for diagnosis.',
    );
  }
  // One JSON object in either mode — the gate parses this with `json.load`
  // whether or not `--json` was passed — so `emitRecord`, which serializes on
  // both arms. `emit`'s human arm redacts PROSE, and redacting a serialized
  // document is how a credential run colliding with a numeric field produced
  // output no parser accepts (output.ts).
  report.emitRecord(
    (dump ?? { live: false, sid: null, never: true }) as unknown as Record<string, unknown>,
  );
}

function cmdWhoami(name: string, report: Reporter): void {
  const profile = loadProfile(name);
  // `--json` is the PROGRAMMATIC shape, and it exposes the ULID and the
  // locally authored name — nothing else. The identity public key stays on
  // the human path below (a person comparing key material at a terminal is
  // the use it serves); an automated caller that can be talked into running
  // `whoami --json` and forwarding the output should be handing over an
  // address, not key material an attacker can correlate accounts with
  //.
  // The account CLASS and its binding are safe to expose on both paths and
  // belong on both: an integration behaves differently from an ordinary
  // account in a way that is otherwise invisible until a send is refused with
  // a 403, and "unbound" is a diagnosis where "it doesn't work" is not.
  const kind = profile.accountClass === 'integration' ? 'integration' : 'human';
  const binding =
    profile.accountClass === 'integration'
      ? { boundTo: profile.ownerUserId ?? null }
      : {};

  // THROUGH THE REPORTER, and this was a DISCLOSURE rather than a tidy-up.
  // Both arms used to call `console.log(JSON.stringify(…))` directly, which is
  // a structured printer standing outside the credential chokepoint: JSON
  // framing escapes control bytes, and escapes a session token into a
  // perfectly well-formed string. `AuthResponse.userId` is a plain
  // `z.string()`, so a server may answer with the bearer as the userId — and
  // this command is the one an operator scripts, whose output a hook forwards
  // and a ticket quotes. `Reporter.emit` now redacts at the serialization
  // boundary (output.ts), so both shapes below inherit it.
  const record = {
    name: profile.name,
    userId: profile.userId,
    class: kind,
    ...binding,
    // Human path only, exactly as before: `--json` returns above this line
    // with the key absent from the record it emits.
    ...(report.json ? {} : { identityKey: profile.identityKey }),
  };
  // Compact under `--json`, pretty two-space otherwise: the e2e gates read
  // this with JSON.parse and python's json.load respectively, so the only real
  // contract is "stdout is JSON and nothing else".
  //
  // `emitRecord`, NOT `emit`, and this line was the last place in the package
  // where a JSON DOCUMENT was handed to a prose redactor. `emit`'s human arm is
  // `redactCredentials(human)` — a substring pass over the serialized text —
  // and the server chooses the token, so it chooses where the run lands. A
  // valid base64url `authToken` opening `identity` renamed this record's
  // `identityKey`; one opening `"identity` consumed the field's OPENING QUOTE
  // and printed something no parser accepts, from the command whose whole
  // contract is `MSG=$(tacendum whoami ci-bot)`. Both are ordinary `z.string()`
  // values a server is free to mint (output.ts, and the gate that reproduces it
  // through this binary).
  //
  // Passing the record itself means the values are redacted BEFORE the encoder
  // runs, in either mode, so a marker can only ever land inside a JSON string:
  // the document is valid by construction. `pretty` is layout only and is
  // ignored under `--json`, so the machine shape is byte-for-byte what it was.
  report.emitRecord(record, { pretty: true });
}

/** Print the safety number for (name, peer) in Signal's 5-digit groups. */
async function cmdSafety(name: string, peerName: string, report: Reporter): Promise<void> {
  const stores = new FileStores(name);
  const profile = loadProfile(name);
  const peerUserId = resolveRecipient(peerName);
  const number = await computeSafetyNumber(stores, profile.userId, peerUserId);
  if (!number) {
    throw new CliError(
      EXIT.RECIPIENT,
      `no session with ${peerName} yet — exchange a message first, then compare safety numbers`,
    );
  }
  const grouped = (number.match(/.{1,5}/g) ?? []).join(' ');
  if (report.json) {
    report.emit({ ok: true, name, peer: peerName, peerUserId, safetyNumber: number }, '');
  } else {
    // Two lines, digits only on the second, indented two spaces: e2e.sh check
    // 6 parses this with `grep -oE '[0-9 ]{60,}'`, so the header line must
    // stay digit-free or the regex takes it instead.
    console.log(`safety number ${name} <-> ${peerName}:`);
    console.log(`  ${grouped}`);
  }
  report.note('compare this out of band with the peer; it must match on both devices');
}

/**
 * Accept a peer's changed identity (re-pin + reset session).
 *
 * REFUSES WHEN NOTHING IS PENDING, and that guard is the whole point of the
 * command being a command rather than a one-liner. Before it, `trust` cleared
 * the pinned key and the session UNCONDITIONALLY and then reported
 * "accepted a new identity for X" — whether or not anything had changed. So a
 * typo'd peer name, or simply running it twice, silently tore down a healthy
 * ratchet and un-pinned a key the operator had already verified out of band,
 * while telling them a safety number had changed when it had not. The next
 * `tacendum safety` then failed with "no session yet", which reads as a
 * different bug entirely. Un-pinning a verified peer is exactly the state a
 * MITM wants a client in; doing it by accident, and being told it was
 * intentional, is the failure worth refusing.
 *
 * "Pending" means THIS client recorded a refusal — and the reason to trust
 * that is an INVARIANT with named enforcement points, not a census of call
 * sites. A census here has already rotted: this paragraph said
 * `attachInbound` and `cmdSend` were "the only two places libsignal can
 * raise an identity change" while the tree had four recording sites (rounds
 * 8 and 9 added CallSession's decrypt catch and the outbound bootstrap).
 * The invariant: whatever surfaces libsignal's UntrustedIdentity records it
 * before the operator sees a warning, and every warning names this command.
 * It is enforced where the error passes, not per command: `establishSession`
 * (messaging.ts) records at the raise site for every outbound bootstrap, and
 * both inbound decrypt paths record on `classifyDecryptFailure`'s
 * 'identity-change' disposition (inbound.ts, call-session.ts).
 * `test/gate.identity-change-parity.test.ts` fails if any of the three stops
 * recording; `grep -rn 'tacendum trust \$' packages/cli/src` lists exactly
 * the operator-facing strings that advertise this command. A new surface
 * that lets libsignal raise this error owes the same record and a cell in
 * that suite — not a new name in this sentence, which is how the last
 * version went stale.
 */
function cmdTrust(name: string, peerName: string, report: Reporter): void {
  const stores = new FileStores(name);
  const peerUserId = resolveRecipient(peerName);

  if (!stores.hasIdentityChange(peerUserId)) {
    throw new CliError(
      EXIT.USAGE,
      `nothing to accept for ${peerName}: no identity change is pending on this client. ` +
        `Trusting anyway would un-pin a key you have already verified and reset a working ` +
        `session, so it is refused. Run this only after a "SAFETY NUMBER CHANGED" warning.`,
    );
  }

  acceptPeerIdentityChange(stores, peerUserId);
  stores.clearIdentityChange(peerUserId);
  if (report.json) {
    report.emit({ ok: true, name, peer: peerName, peerUserId, action: 'trusted' }, '');
  }
  report.note(
    `accepted a new identity for ${peerName}; the next message re-pins it (TOFU). ` +
      `Verify the new safety number out of band.`,
  );
}

/**
 * The contract, and the one place it is stated to an operator.
 *
 * THE `--json` EXEMPTION FOR LIVE CALLS IS WRITTEN INTO THE TEXT BELOW, and
 * this is why. `--json` promises "machine-readable stdout (one JSON object, or
 * one per line)". A live call session does not keep that promise and never
 * has: FOUR sites write a human line to stdout with `console.log`, and not one
 * of them has ever been handed a Reporter to ask. Enumerated, because a count
 * is what a future implementer will act on and the previous version of this
 * note was short by one:
 *
 *   call.ts `CallRunner.emit`             `CALL <event> …`
 *   group-call.ts `GroupCallRunner.emit`  `GCALL <event> …`
 *   call-session.ts `CallSession.render`  `[peer] <text>`
 *   call-session.ts, the QUARANTINE       `[peer] <text>`
 *     FALLBACK in the frame handler
 *
 * The fourth is the one that hides. It is not part of `render` and is not
 * reached through it: when the message log refuses an append (ENOSPC is the
 * ordinary cause), the handler preserves the plaintext, declines to ack, and
 * prints the body itself — the LAST copy — then returns before `render` is
 * ever called. So it fires on the failure path of a correct run, which is
 * exactly when a machine consumer is least able to cope with a surprise, and
 * it is invisible to anyone who searches for the prints inside `render`.
 *
 * The list is stdout only, and it is the whole of stdout for these commands:
 * `cmdCall`, `cmdCallGroup` and `cmdListenCalls` reach the Reporter only
 * through `report.note`, which is stderr. Verified by reading every
 * `console.log`/`process.stdout.write` in packages/cli/src and keeping the
 * ones a live call can reach — `inbound.ts` has none at all, and `mcp.ts`
 * rebinds `console.log` to stderr for its own stream.
 *
 * DOCUMENTED RATHER THAN FIXED, deliberately, and the reasoning is not "it is
 * hard". A JSON call surface would be a new WIRE CONTRACT — event names, field
 * names, a version — invented on the spot for a stream that today has exactly
 * two consumers, both of which read the human lines: the e2e gate's provenance
 * scanner (`^(GCALL|CALL) `) and an operator watching a terminal. And it would
 * have to be invented in all FOUR at once or the mode gets worse than it is:
 * half a fix streams JSON objects for a group call while the 1:1 legs beside
 * them still print `CALL …`, which is a mixed stream — still rejected by a
 * JSON reader, and now inconsistent between two commands that an operator
 * reasonably expects to behave alike. A three-quarters fix is worse again: it
 * leaves the quarantine fallback emitting a human line into a JSON stream on
 * the one path where the message being printed is the only copy left.
 *
 * What a machine consumer is owed instead is a projection it can actually
 * parse, and both already exist as commands of their own: `calllog` (JSONL,
 * one row per terminal call — `cmdCallLog` records its own `--json` exemption
 * for the same reason) and `gcall` (one JSON object of session state, which is
 * what the e2e gate asserts convergence on, precisely because "the client
 * printed the right words" is a weaker claim than "the client holds the right
 * roster").
 *
 * If a live JSON call stream is ever wanted, it is those four sites together
 * plus a schema, and this paragraph is the note saying so.
 */
const HELP = `tacendum — end-to-end encrypted notifications to your phone

usage:
  tacendum register <name> [--integration]
  tacendum pair <name> <owner-id>
  tacendum send <from> <to> ["<text>" | - | --attach <file>] [--title T] [--drain]
  tacendum listen <name> [--calls] [--group] [--auto-answer|--auto-decline]
                         [--seconds N] [--leave-after N] [--save-dir <dir>]
                         [--detail]        chat stream only; refused with --calls
  tacendum sync <name> [--save-dir <dir>]
  tacendum inbox <name> [--peer <id>] [--limit N] [--unread] [--peek] [--purge]
                        [--detail]
  tacendum contacts <name>
  tacendum doctor <name>
  tacendum call <from> <to> [--video] [--ice N] [--seconds N]
  tacendum call <from> --group <peer>... [--seconds N] [--leave-after N]
                                         [--add <peer> [--add-after N]]
  tacendum calllog <name>
  tacendum gcall <name>
  tacendum room create <name> <roomName> <memberId>...
  tacendum room list <name> | show <name> <groupId>
  tacendum room add|remove <name> <groupId> <memberId>
  tacendum room accept|decline|leave <name> <groupId>
  tacendum room delete <name> <groupId> [--everyone]
  tacendum room send <name> <groupId> "<text>" | --attach <file>
  tacendum whoami <name>
  tacendum safety <name> <peer>
  tacendum trust <name> <peer>
  tacendum setup <surface> --name "<display name>" [--owner <id>]
  tacendum run <from> [<to>] [--name <label>] -- <command> [args...]
  tacendum notify --hook claude|codex|gemini|cursor --account <name> [--to <id>] [--title T]
  tacendum credential <name> [--migrate [--remove-file]]
  tacendum crew voice
  tacendum crew adopt <account> <member-id>
  tacendum consent grant|revoke <account> <agent-id>
  tacendum consent list <account>
  tacendum service install|uninstall|status <account>
  tacendum attend enable|disable|run <account> [--host claude|codex|gemini] [--bin P] [--workdir D]
      [--turns N] [--caps "<args>"] [--driver exec|app-server] [--approval-policy untrusted|on-request|never]
      [--approvals <min-app-build>] [--stream <min-app-build>] [--marker <min-app-build>]
  tacendum attend status [<account>]
  tacendum attend triggers <account> [<room-gid> on|off]
  tacendum attend rounds <account> [<room-gid> on|off]
  tacendum attend service install|uninstall|status <account>
  tacendum review-peer run <account>
  tacendum review-peer service install|uninstall|status <account>
  tacendum mcp --account <name> [--notify-owner] [--ask-owner]
  tacendum mcp install --host claude-desktop|claude-code|codex [--account <name>] [--write]
  tacendum --version

<to> and <peer> are a local client name, or a bare 26-character user id.

integrations: an account a tool or agent sends from is registered with
  --integration, then paired once to the person it may notify:

    tacendum register ci --integration
    tacendum pair ci <your-user-id>      # the id on your phone's own code screen

  A paired integration may message that one person and nobody else, cannot
  ring a phone, and can be revoked from the phone at any time. Registering
  without --integration makes an ordinary account with none of those bounds.

crews: an owner running a fleet of agents can adopt their paired
  integrations into one crew ("tacendum crew adopt"); crew-mates may then
  message each other as well as the owner — never anyone else. Adoption is
  always the owner's call: an agent can never admit another agent.
  "tacendum crew voice" prints the chat-voice instructions setup installs.

global options:
  --json    machine-readable stdout (one JSON object, or one per line)
            NOT honoured by a LIVE CALL SESSION — "call", "call --group" and
            "listen --calls" stream human CALL/GCALL signalling lines and
            chat on stdout whether or not --json is asked for. The machine
            view of a call is a command of its own: "tacendum calllog <name>"
            (one JSON row per terminal call) and "tacendum gcall <name>" (one
            JSON object of small-group session state). Piping a live call
            through a JSON-lines reader will not work; read those instead.
  --plain   stable stdout, no progress line, no colour
  --help    this text
  --        end option parsing; everything after it is a positional

send options:
  --title T        a summary line placed above the body
  --drain          also consume this account's own queued messages (decrypt + ack)
  --attach <file>  send the file as an end-to-end encrypted attachment (the file
                   is the whole message; the blob is uploaded once and its key
                   travels only inside the encrypted envelope)
  -                a body of exactly - means READ STDIN, deliberately: honoured
                   even at a terminal, where it waits for EOF. To send a
                   literal - as the body, pipe it:
                     printf -- - | tacendum send <from> <to>
  the body may be piped on stdin:  make build || tacendum send ci me --title "build failed"
    (an OMITTED body reads stdin only when stdin is not a terminal)

listen/sync --save-dir <dir>: incoming 1:1 file attachments are fetched,
  decrypted and written under <dir> at receive time. Without it the line shows
  [file <name> (<size> bytes)] and the attachment is not retrievable later —
  the message log never stores attachment ids or keys.

sync drains the queue into the local message log and exits (cron-friendly).
inbox reads that log newest-first and marks what it returned as read:
  --peer <id>  only this peer     --limit N   at most N (default 20; 0 = all)
  --unread     only unread        --peek      read without marking read
  --purge      purge consumed message bodies from disk now, list nothing
doctor prints PASS/FAIL per check with a remedy; exits non-zero on any FAIL.
room: end-to-end encrypted group chat. A room is N pairwise-encrypted legs —
  there is no group key and no server roster; each client folds the roster
  for itself. add/remove/delete --everyone count only from the room's owner;
  accept/decline answer an invitation; run \`tacendum room --help\` for detail.
mcp serves the Model Context Protocol over stdio: three read-side tools
  (whoami, read_messages, acknowledge_messages) and NO send tool by default.
  --notify-owner adds tacendum_notify_owner, which sends a short message to
  the account's bound owner ONLY — the recipient is enforced server-side.
  --ask-owner adds tacendum_ask_owner, which sends ONE question to the bound
  owner and parks the tool call until the reply or its TTL (30s-1h, default
  10m); while parked, the server answers no other request. The flags are
  independent: either, both, or neither.
mcp install prints the host's config block; --write merges it into the host's
  config file (one rolling .bak backup first, unrelated keys untouched).

exit codes:
  0 ok   1 error   3 auth   4 network   5 recipient   6 safety
  7 timeout (no reply — a retry may help)   8 rate-limited (wait, then retry)
  9 usage (the command line was wrong; retrying it cannot help)
  10 refused (the server said no, permanently — do not retry)
  2 is never used: it is Claude Code's blocking hook code.

environment:
  TACENDUM_API   REST base (default https://api.tacendum.com)
  TACENDUM_WS    socket url (default wss://ws.tacendum.com)
  TACENDUM_HOME  client store root (default ~/.tacendum)
  NO_COLOR       implies --plain`;

function requirePositional(args: ParsedArgs, index: number, usage: string): string {
  const value = args.positionals[index];
  if (!value) throw new CliError(EXIT.USAGE, `usage: ${usage}`);
  return value;
}

/**
 * Resolve THIS MACHINE'S account positional — and, having just learned which
 * account the command is about, run the once-per-command credential hook
 * (keychain.ts): on the first run after an OS keychain becomes available it
 * migrates the credential in, and forever after it is a marker read.
 *
 * One helper rather than a call pasted into each command, because a rule
 * duplicated per call site is this repo's most-repeated defect class — every
 * command that names its local account gets the hook by resolving the name
 * through here. `maybeMigrateCredential` swallows every failure by design
 * (even a hostile PATH shim), so this can never take the command down; the
 * note carries only keychain.ts's fixed prose and backend name, never the
 * account name or the credential.
 *
 * Deliberately NOT used by: `doctor` (it observes and must never repair —
 * this hook writes a keychain item and a marker) and `credential` (the
 * explicit command, where the same migration must surface its errors instead
 * of swallowing them). Peer/owner positionals (send's <to>, safety's <peer>,
 * pair's <owner-id>) stay on `requirePositional`: they are not accounts on
 * this machine.
 */
function requireAccount(args: ParsedArgs, index: number, usage: string): string {
  const name = requirePositional(args, index, usage);
  const outcome = maybeMigrateCredential(name);
  if (outcome !== null) report.note(`credential: ${outcome.detail} (${outcome.backend})`);
  return name;
}

/**
 * ONE rule for "was --json asked for", read once, at module scope.
 *
 * There used to be three: a prefix filter feeding a permissive `parseArgs`, the
 * per-command spec, and `process.argv.includes('--json')` in the failure
 * handler. They disagreed, and the failure handler in particular could not
 * reach a Reporter at all — so an interactive failure printed its message glued
 * onto the un-terminated status line ("connecting…error: ..."), because nothing
 * on that path ever cleared it.
 *
 * Module scope, not inside `main()`, precisely so the rejection handler below
 * can retire that line. `scanGlobals` is a pure argv walk that cannot throw, so
 * constructing this eagerly cannot itself become the thing that fails.
 */
const report = new Reporter(scanGlobals(process.argv.slice(3)));

async function main(): Promise<ExitCode | number> {
  const [, , command, ...argv] = process.argv;

  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    console.log(HELP);
    return EXIT.OK;
  }

  // Handled before the switch, like --help: version is answerable with no
  // account, no store and no network, and must stay answerable that way.
  if (command === '--version' || command === 'version') {
    cmdVersion(report);
    return EXIT.OK;
  }

  // Windows is refused at the front door, honestly, before any command can
  // reach a store. Deliberately AFTER --help/--version: printing
  // text carries no platform assumption, and the person on the wrong OS
  // deserves the answer that names the refusal.
  assertPlatformSupported();

  switch (command) {
    case 'register': {
      // --integration must be in the spec, not just read afterwards: the
      // parser refuses unknown flags, so the documented safe path threw
      // `unknown option --integration` before cmdRegister ever ran, and every
      // account this product created was human-class.
      const args = parseArgs(argv, { boolean: ['--integration'] });
      if (flagBool(args, '--help')) return console.log(HELP), EXIT.OK;
      await cmdRegister(
        requireAccount(args, 0, 'tacendum register <name> [--integration]'),
        report,
        flagBool(args, '--integration'),
      );
      break;
    }
    case 'pair': {
      const args = parseArgs(argv);
      if (flagBool(args, '--help')) return console.log(HELP), EXIT.OK;
      const usage = 'tacendum pair <name> <owner-ulid>';
      await cmdPair(
        requireAccount(args, 0, usage),
        requirePositional(args, 1, usage),
        report,
      );
      break;
    }
    case 'send': {
      const args = parseArgs(argv, { value: ['--title', '--attach'], boolean: ['--drain'] });
      if (flagBool(args, '--help')) return console.log(HELP), EXIT.OK;
      const usage = 'tacendum send <from> <to> ["<text>" | - | --attach <file>] [--title T]';
      const from = requireAccount(args, 0, usage);
      const to = requirePositional(args, 1, usage);
      if (args.positionals.length > 3) {
        // An unquoted body splits into words: a Make variable expanding to
        // `send ci owner build failed` sent "build", silently dropped
        // "failed", and exited 0 — a notifier that truncates the one line it
        // exists to carry. The extra words are NEVER
        // echoed: a missing quote is exactly how a secret or a message body
        // lands in argv, and this error reaches stderr and --json, i.e. hook
        // and CI logs (same rule as args.ts's rejected-flag path).
        throw new CliError(
          EXIT.USAGE,
          `send takes one body argument, got ${args.positionals.length - 2} — an unquoted ` +
            'body splits into words and all but the first would be dropped. Quote the ' +
            'body, pipe it on stdin, or put -- before a body that starts with a dash.',
        );
      }
      await cmdSend(
        from,
        to,
        // Absent (not empty) means "read stdin". An explicit "" is still a
        // legal, if pointless, positional and is treated as empty text.
        args.positionals[2],
        {
          title: flagString(args, '--title'),
          attach: flagString(args, '--attach'),
          drain: flagBool(args, '--drain'),
        },
        report,
      );
      break;
    }
    case 'listen': {
      const args = parseArgs(argv, {
        value: ['--seconds', '--leave-after', '--save-dir'],
        boolean: ['--calls', '--auto-answer', '--auto-decline', '--group', '--detail'],
      });
      if (flagBool(args, '--help')) return console.log(HELP), EXIT.OK;
      const name = requireAccount(args, 0, 'tacendum listen <name> [--calls]');
      if (flagBool(args, '--calls')) {
        // REFUSED, not ignored. `--detail` must be declared for the whole
        // subcommand because args.ts refuses an unknown flag rather than
        // dropping it — but accepting it here and doing nothing is that same
        // lie one level in: `listen --calls` streams call signalling, has no
        // message body to widen, and the operator would have no way to tell
        // a silent no-op from a message that carried no detail.
        if (flagBool(args, '--detail')) {
          throw new CliError(
            EXIT.USAGE,
            'tacendum listen --calls does not take --detail — call signalling has no message body',
          );
        }
        await cmdListenCalls(
          name,
          {
            autoAnswer: flagBool(args, '--auto-answer'),
            autoDecline: flagBool(args, '--auto-decline'),
            seconds: flagCount(args, '--seconds', 30),
            group: flagBool(args, '--group'),
            leaveAfter: flagCount(args, '--leave-after', 0),
          },
          report,
        );
      } else {
        // `--detail` is a chat-stream flag and is read on THIS arm only; the
        // `--calls` arm above refuses the combination outright rather than
        // accepting a flag it would not act on.
        await cmdListen(name, report, flagString(args, '--save-dir'), flagBool(args, '--detail'));
      }
      break;
    }
    case 'sync': {
      const args = parseArgs(argv, { value: ['--save-dir'] });
      if (flagBool(args, '--help')) return console.log(HELP), EXIT.OK;
      await cmdSync(
        requireAccount(args, 0, 'tacendum sync <name>'),
        report,
        flagString(args, '--save-dir'),
      );
      break;
    }
    case 'inbox': {
      const args = parseArgs(argv, {
        value: ['--peer', '--limit'],
        boolean: ['--unread', '--peek', '--purge', '--detail'],
      });
      if (flagBool(args, '--help')) return console.log(HELP), EXIT.OK;
      const name = requireAccount(args, 0, 'tacendum inbox <name> [--peer <id>] [--limit N]');
      const peerFlag = flagString(args, '--peer');
      cmdInbox(
        name,
        {
          // `--peer` takes a name or an id like every other peer argument;
          // the log stores ids, so a name resolves before filtering.
          peer: peerFlag !== undefined ? resolveRecipient(peerFlag) : undefined,
          limit: flagCount(args, '--limit', 20),
          unread: flagBool(args, '--unread'),
          peek: flagBool(args, '--peek'),
          purge: flagBool(args, '--purge'),
          detail: flagBool(args, '--detail'),
        },
        report,
      );
      break;
    }
    case 'contacts': {
      const args = parseArgs(argv);
      if (flagBool(args, '--help')) return console.log(HELP), EXIT.OK;
      cmdContacts(requireAccount(args, 0, 'tacendum contacts <name>'), report);
      break;
    }
    case 'doctor': {
      const args = parseArgs(argv);
      if (flagBool(args, '--help')) return console.log(HELP), EXIT.OK;
      const code = await cmdDoctor(requirePositional(args, 0, 'tacendum doctor <name>'), report);
      report.done();
      return code;
    }
    case 'call': {
      const args = parseArgs(argv, {
        value: ['--ice', '--seconds', '--leave-after', '--add', '--add-after'],
        boolean: ['--video', '--group'],
      });
      if (flagBool(args, '--help')) return console.log(HELP), EXIT.OK;
      const usage = 'tacendum call <from> <to> [--video] [--ice N]';
      if (flagBool(args, '--group')) {
        // `call <from> --group <peer>…` — the account stays positional 0, as
        // it is on every command (one TACENDUM_HOME can hold several
        // accounts), and the callees follow it. A one-peer `--group` is
        // deliberately legal: the reducer, not this switch, decides what a
        // roster may be, and refusing shapes here would be a second copy of
        // call.ts's rule.
        // The usage line no longer advertises `--video` on a group call:
        // v1 group calls ship AUDIO ONLY. The flag itself stays parseable below,
        // deliberately: removing behaviour is a session-layer decision this
        // copy fix must not smuggle in, and an undocumented flag is not a
        // product claim.
        const groupUsage = 'tacendum call <from> --group <peer>... [--seconds N]';
        const from = requireAccount(args, 0, groupUsage);
        const peers = args.positionals.slice(1);
        if (peers.length === 0) throw new CliError(EXIT.USAGE, `usage: ${groupUsage}`);
        const seconds = flagCount(args, '--seconds', 10);
        // `--add` without a time is a late join that never happens, and a
        // silent no-op is exactly the vacuity the defect was about. The
        // default is the MIDPOINT of the run: late by construction (the
        // session has formed), and early enough that the joiner's legs have
        // the same window to converge that the original ones did.
        await cmdGroupCall(
          from,
          peers,
          {
            video: flagBool(args, '--video'),
            seconds,
            leaveAfter: flagCount(args, '--leave-after', 0),
            add: flagString(args, '--add'),
            addAfter: flagCount(args, '--add-after', Math.max(1, Math.floor(seconds / 2))),
          },
          report,
        );
        break;
      }
      await cmdCall(
        requireAccount(args, 0, usage),
        requirePositional(args, 1, usage),
        {
          video: flagBool(args, '--video'),
          ice: flagCount(args, '--ice', 0),
          seconds: flagCount(args, '--seconds', 10),
        },
        report,
      );
      break;
    }
    case 'calllog': {
      const args = parseArgs(argv);
      if (flagBool(args, '--help')) return console.log(HELP), EXIT.OK;
      cmdCallLog(requireAccount(args, 0, 'tacendum calllog <name>'), report);
      break;
    }
    case 'gcall': {
      const args = parseArgs(argv);
      if (flagBool(args, '--help')) return console.log(HELP), EXIT.OK;
      cmdGroupCallState(requireAccount(args, 0, 'tacendum gcall <name>'), report);
      break;
    }
    case 'whoami': {
      const args = parseArgs(argv);
      if (flagBool(args, '--help')) return console.log(HELP), EXIT.OK;
      cmdWhoami(requireAccount(args, 0, 'tacendum whoami <name>'), report);
      break;
    }
    case 'safety': {
      const args = parseArgs(argv);
      if (flagBool(args, '--help')) return console.log(HELP), EXIT.OK;
      const usage = 'tacendum safety <name> <peer>';
      await cmdSafety(
        requireAccount(args, 0, usage),
        requirePositional(args, 1, usage),
        report,
      );
      break;
    }
    case 'trust': {
      const args = parseArgs(argv);
      if (flagBool(args, '--help')) return console.log(HELP), EXIT.OK;
      const usage = 'tacendum trust <name> <peer>';
      cmdTrust(requireAccount(args, 0, usage), requirePositional(args, 1, usage), report);
      break;
    }
    case 'room': {
      // The room surface: create, list, show, add, remove,
      // leave, accept, decline, delete [--everyone], send — every roster
      // decision made by @tacendum/shared/group-fold, never here. Returns
      // its own code (doctor's pattern): a fan-out that could not tell every
      // member exits non-zero while the local change stands, and the code
      // says which kind of shortfall (see room-commands.ts).
      const code = await cmdRoom(argv, report);
      report.done();
      return code;
    }
    case 'setup': {
      // Onboarding: register an integration account, pair it to the operator's
      // phone, send the profile card that names the sender, and write the
      // host's hook config. It preflights the config write BEFORE touching the
      // network, because a run that registers and pairs and THEN cannot write
      // the config leaves the operator in a state no command reports.
      await cmdSetup(argv, report);
      break;
    }
    case 'run': {
      // The universal fallback for tools with no hooks. Its exit code is the
      // CHILD's, so it drops into a script unchanged — the one exception is
      // documented in run.ts, because silently rewriting a build's exit code
      // is its own defect. This is why `main` returns `ExitCode | number` and
      // not `ExitCode`: every other command answers from our own table, and
      // this one answers with a code we did not choose (including 126 and 127,
      // the shell's not-runnable and not-found). Widening the type is the
      // honest way to say that; a cast here would have hidden it.
      return await cmdRun(argv, report);
    }
    case 'notify': {
      // Every agent surface funnels here. cmdNotify HARD-EXITS on the hook
      // paths — an abandoned TCP dial otherwise holds the event loop open for
      // the OS connect timeout, and a hook that hangs is a hook that blocks
      // the agent it was meant to report on. Nothing may follow this call.
      await cmdNotify(argv, report);
      break;
    }
    case 'crew': {
      // Crew surface (crew-chat spec). `voice` prints the canonical
      // crew-chat instruction text so any host — including ones setup cannot
      // safely write into — can consume it. `adopt` is the owner-side
      // admission call; crew.ts records why there is no list and no remove.
      const sub = argv[0];
      if (sub === 'voice') {
        // Through the reporter, not console.log: --json means ONE JSON
        // object on stdout, for this command like every other. And a stray
        // extra POSITIONAL is refused, not ignored — the gate's canary rode
        // one silently. parseArgs, not argv.length: global flags (--json,
        // --plain) legitimately remain in argv here.
        const args = parseArgs(argv.slice(1));
        if (flagBool(args, '--help')) return console.log(HELP), EXIT.OK;
        if (args.positionals.length > 0) {
          throw new CliError(EXIT.USAGE, 'usage: tacendum crew voice');
        }
        report.emit({ ok: true, action: 'voice', text: CREW_VOICE_BODY }, CREW_VOICE_BODY.trimEnd());
        break;
      }
      if (sub === 'adopt') {
        const args = parseArgs(argv.slice(1));
        if (flagBool(args, '--help')) return console.log(HELP), EXIT.OK;
        const usage = 'tacendum crew adopt <account> <member-id>';
        // Exactly two positionals: a third rode through silently once, and an argument this command ignores is an argument
        // the operator believed did something.
        if (args.positionals.length > 2) throw new CliError(EXIT.USAGE, `usage: ${usage}`);
        await cmdCrewAdopt(
          requireAccount(args, 0, usage),
          requirePositional(args, 1, usage),
          report,
        );
        break;
      }
      throw new CliError(
        EXIT.USAGE,
        'usage: tacendum crew voice | tacendum crew adopt <account> <member-id>',
      );
    }
    case 'consent': {
      // The pairwise consent edge: grant writes
      // the directed (you -> agent) edge the server enforces at delivery,
      // revoke deletes it, and `list` reads back THIS CLIENT'S OWN record
      // of its grants — a local file, never a server read (consent.ts
      // records why the server route stays uniform and enumeration-free).
      // Modelled on `crew`: subcommand as positional 0, exact positional
      // counts, refusals before any credential is touched.
      const sub = argv[0];
      const usage = 'tacendum consent grant|revoke <account> <agent-id> | consent list <account>';
      if (sub === 'grant' || sub === 'revoke') {
        const args = parseArgs(argv.slice(1));
        if (flagBool(args, '--help')) return console.log(HELP), EXIT.OK;
        // Exactly two positionals — crew adopt's rule: an argument this
        // command ignores is an argument the operator believed did something.
        if (args.positionals.length > 2) throw new CliError(EXIT.USAGE, `usage: ${usage}`);
        await cmdConsent(
          sub,
          requireAccount(args, 0, usage),
          requirePositional(args, 1, usage),
          report,
        );
        break;
      }
      if (sub === 'list') {
        const args = parseArgs(argv.slice(1));
        if (flagBool(args, '--help')) return console.log(HELP), EXIT.OK;
        if (args.positionals.length > 1) throw new CliError(EXIT.USAGE, `usage: ${usage}`);
        cmdConsentList(requireAccount(args, 0, usage), report);
        break;
      }
      throw new CliError(EXIT.USAGE, `usage: ${usage}`);
    }
    case 'service': {
      // The login agent that keeps `listen` alive (service.ts records why a
      // supervised listen, and not an opportunistic drain inside notify, is
      // the shape that fits the routing-row rule).
      const args = parseArgs(argv);
      if (flagBool(args, '--help')) return console.log(HELP), EXIT.OK;
      const usage = 'tacendum service install|uninstall|status [<account>]';
      if (args.positionals.length > 2) throw new CliError(EXIT.USAGE, `usage: ${usage}`);
      // The account is OPTIONAL here, unlike everywhere else: bare `status`
      // answers for every account, and a bare mutation names the options
      // (service.ts records the reasoning). requireAccount would pre-empt
      // both with a usage line.
      cmdService(
        requirePositional(args, 0, usage),
        args.positionals[1] ?? null,
        report,
      );
      break;
    }
    case 'attend': {
      // The machine answers. enable is the deliberate opt-in;
      // run is the loop the unit supervises; disable stops execution while
      // messages keep queuing for reading.
      //
      // The WHOLE argv is parsed, subcommand included. It used to slice the
      // subcommand off first and parse the rest, which made `tacendum attend
      // --help` unanswerable: `--help` was the sliced-off word, the parsed
      // remainder held no help flag and no account, and the operator asking
      // for help got a usage error and exit 9. A subcommand is just
      // positional 0.
      const args = parseArgs(argv, {
        value: [
          '--host', '--bin', '--workdir', '--turns', '--caps', '--driver',
          '--approval-policy', '--approvals', '--stream', '--marker',
        ],
      });
      if (flagBool(args, '--help') || flagBool(args, '-h')) return console.log(HELP), EXIT.OK;
      const usage =
        'tacendum attend enable|disable|run <account> [--host claude|codex|gemini] [--bin P] ' +
        '[--workdir D] [--turns N] [--caps "<args>"] [--driver exec|app-server] ' +
        '[--approval-policy untrusted|on-request|never] [--approvals <min-app-build>] ' +
        '[--stream <min-app-build>] [--marker <min-app-build>] | ' +
        'tacendum attend status [<account>] | ' +
        'tacendum attend triggers <account> [<room-gid> on|off] | ' +
        'tacendum attend rounds <account> [<room-gid> on|off] | ' +
        'tacendum attend service install|uninstall|status <account>';
      const sub = args.positionals[0] ?? '';
      if (sub === 'triggers') {
        // The owner's per-room trigger grant: two positionals
        // deeper than the others — account, then an optional gid+verb pair.
        // Three positionals total is the read-back-with-a-gid typo (a verb
        // lost its shell quoting) and is refused like every other surplus.
        if (args.positionals.length !== 2 && args.positionals.length !== 4) {
          throw new CliError(EXIT.USAGE, `usage: ${usage}`);
        }
        cmdAttendTriggers(
          requireAccount(args, 1, usage),
          args.positionals[2] ?? null,
          args.positionals[3] ?? null,
          report,
        );
        break;
      }
      if (sub === 'rounds') {
        // The owner's per-room ROUNDS grant — `triggers`'
        // grammar exactly, positional for positional: two positionals read
        // the list back, four set one room, and three is the lost-quoting
        // typo every surplus is refused as.
        if (args.positionals.length !== 2 && args.positionals.length !== 4) {
          throw new CliError(EXIT.USAGE, `usage: ${usage}`);
        }
        cmdAttendRounds(
          requireAccount(args, 1, usage),
          args.positionals[2] ?? null,
          args.positionals[3] ?? null,
          report,
        );
        break;
      }
      if (sub === 'service') {
        // `attend service <install|uninstall|status> <account>`: one
        // positional deeper than the others.
        if (args.positionals.length > 3) throw new CliError(EXIT.USAGE, `usage: ${usage}`);
        cmdAttendService(args.positionals[1] ?? '', args.positionals[2] ?? null, report);
        break;
      }
      if (sub === 'status') {
        // The read-only positional path, NOT `requireAccount`: that helper
        // runs the once-per-command credential migration, which writes a
        // keychain item and a marker, and a status command observes only —
        // `attend service status` above already makes the same choice. The
        // account is optional for the same reason `service status`'s is:
        // status is a question, and bare answers for every account.
        if (args.positionals.length > 2) throw new CliError(EXIT.USAGE, `usage: ${usage}`);
        cmdAttendStatus(args.positionals[1] ?? null, report);
        break;
      }
      // The subcommand is checked BEFORE the account, so a typo does not first
      // run the credential-migration hook for an account it will then refuse.
      if (sub !== 'enable' && sub !== 'disable' && sub !== 'run') {
        throw new CliError(EXIT.USAGE, `usage: ${usage}`);
      }
      // A SURPLUS POSITIONAL IS A TYPO, not spare change. `attend enable ci
      // turns 5` — a shell line that lost its dashes, or a person guessing the
      // syntax — used to be accepted in full and silently reduced to `attend
      // enable ci`: the budget the operator typed was never set, nothing said
      // so, and `service` is the only subcommand that has ever had a third
      // word. Every other command in this file already refuses its surplus.
      if (args.positionals.length > 2) throw new CliError(EXIT.USAGE, `usage: ${usage}`);
      const account = requireAccount(args, 1, usage);
      if (sub === 'enable') {
        cmdAttendEnable(
          account,
          {
            // PRESENCE, not truthiness. `--host ""` used to be falsy and so
            // "absent", which is the silent-downgrade-to-claude bug wearing a
            // different hat; an empty value is now a value, and a wrong one.
            ...(args.flags.has('--host') ? { host: flagString(args, '--host') as string } : {}),
            ...(args.flags.has('--bin') ? { bin: flagString(args, '--bin') as string } : {}),
            ...(args.flags.has('--workdir')
              ? { workdir: flagString(args, '--workdir') as string }
              : {}),
            // ONE quoted string, whitespace-split (`parseCapsFlag` states
            // the rule and the refusal): a caps surface long recorded as
            // owed — `opts.caps` existed and nothing ever passed it, so
            // opting into a stated capability profile meant hand-editing
            // attend.json.
            ...(args.flags.has('--caps')
              ? { caps: parseCapsFlag(flagString(args, '--caps') as string) }
              : {}),
            // Presence, not truthiness, same as --host: an empty value is a
            // value, and a wrong one — cmdAttendEnable refuses it there.
            ...(args.flags.has('--driver')
              ? { driver: flagString(args, '--driver') as string }
              : {}),
            ...(args.flags.has('--approval-policy')
              ? { approvalPolicy: flagString(args, '--approval-policy') as string }
              : {}),
            // The card ATTESTATION. flagCount, not Number(), for
            // --turns' exact reason: a non-number must refuse at parse, never
            // round-trip through JSON as null. flagCount admits 0, which
            // cmdAttendEnable then refuses — a build floor of zero would be
            // an attestation that gates nothing.
            ...(args.flags.has('--approvals')
              ? { approvalsMinAppBuild: flagCount(args, '--approvals', 0) }
              : {}),
            // The streaming ATTESTATION — --approvals' exact parse:
            // flagCount so a non-number refuses here, and the 0 it admits is
            // refused by cmdAttendEnable (a floor of zero gates nothing).
            ...(args.flags.has('--stream')
              ? { streamMinAppBuild: flagCount(args, '--stream', 0) }
              : {}),
            // The AI-marker ATTESTATION — the same parse, the same
            // refusal split: shape here, floor-of-zero in cmdAttendEnable.
            ...(args.flags.has('--marker')
              ? { markerMinAppBuild: flagCount(args, '--marker', 0) }
              : {}),
            // flagCount, not Number(): a non-number here used to reach
            // JSON.stringify as NaN, land in attend.json as `null`, and make
            // `turns >= null` true on every pass — attend bricked, exit 0,
            // "at its hourly limit" forever. The fallback is unreachable (the
            // flag is present) and exists only to satisfy the signature.
            ...(args.flags.has('--turns')
              ? { turnsPerHour: flagCount(args, '--turns', 0) }
              : {}),
          },
          report,
        );
        break;
      }
      if (sub === 'disable') {
        cmdAttendDisable(account, report);
        break;
      }
      await attendLoop(account, report);
      break;
    }
    case 'review-peer': {
      // The App Review responder (review-peer.ts holds the rationale:
      // canned replies to anyone, no agent behind it, and the two may never
      // be relaxed independently). run is the loop the unit supervises;
      // there is no enable — the rotation ships as a default and the class
      // refusal is the installer's, not a config file's.
      //
      // Modelled on `case 'attend'`, deliberately line for line: the WHOLE
      // argv is parsed so `review-peer --help` is answerable, the subcommand
      // is positional 0, and it is checked BEFORE the account so a typo does
      // not first run the credential-migration hook for an account it will
      // then refuse. Until this case existed the unit's program printed HELP
      // and exited EXIT.USAGE — a crash-loop pinned at launchd's throttle
      // floor (gate.unit-program-registered.test.ts is the red that proved
      // it, and the fence against the next unregistered variant).
      const args = parseArgs(argv);
      if (flagBool(args, '--help') || flagBool(args, '-h')) return console.log(HELP), EXIT.OK;
      const usage =
        'tacendum review-peer run <account> | ' +
        'tacendum review-peer service install|uninstall|status <account>';
      const sub = args.positionals[0] ?? '';
      if (sub === 'service') {
        // `review-peer service <install|uninstall|status> <account>`: one
        // positional deeper than run.
        if (args.positionals.length > 3) throw new CliError(EXIT.USAGE, `usage: ${usage}`);
        cmdReviewPeerService(args.positionals[1] ?? '', args.positionals[2] ?? null, report);
        break;
      }
      if (sub !== 'run') {
        throw new CliError(EXIT.USAGE, `usage: ${usage}`);
      }
      // A surplus positional is a typo, not spare change — attend's rule.
      if (args.positionals.length > 2) throw new CliError(EXIT.USAGE, `usage: ${usage}`);
      const account = requireAccount(args, 1, usage);
      await reviewPeerLoop(account, report);
      break;
    }
    case 'credential': {
      const usage = 'usage: tacendum credential <name> [--migrate [--remove-file]]';
      const args = parseArgs(argv, { boolean: ['--migrate', '--remove-file'] });
      if (flagBool(args, '--help')) return console.log(HELP), EXIT.OK;
      // requirePositional, not requireAccount: this IS the credential
      // command, and the silent hook would pre-empt the loud path.
      cmdCredential(
        requirePositional(args, 0, usage),
        { migrate: flagBool(args, '--migrate'), removeFile: flagBool(args, '--remove-file') },
        report,
      );
      break;
    }
    case 'mcp': {
      // Two lives under one word: `mcp install` is an ordinary printing
      // command; bare `mcp` is the stdio server, on which stdout belongs to
      // the protocol and stderr to everything else (see mcp.ts).
      if (argv[0] === 'install') {
        const args = parseArgs(argv.slice(1), { value: ['--host', '--account'], boolean: ['--write'] });
        if (flagBool(args, '--help')) return console.log(HELP), EXIT.OK;
        if (args.positionals.length > 0) {
          throw new CliError(EXIT.USAGE, 'usage: tacendum mcp install --host <host> [--account <name>] [--write]');
        }
        console.log(
          runMcpInstall({
            host: flagString(args, '--host'),
            account: flagString(args, '--account'),
            write: flagBool(args, '--write'),
          }),
        );
        break;
      }
      const args = parseArgs(argv, { value: ['--account'], boolean: ['--notify-owner', '--ask-owner'] });
      if (flagBool(args, '--help')) return console.log(HELP), EXIT.OK;
      if (args.positionals.length > 0) {
        // A stray positional is far more likely a mistyped subcommand than a
        // deliberate argument, and a server that starts anyway would sit
        // silent on stdio while the operator waits for the thing they meant.
        throw new CliError(
          EXIT.USAGE,
          'usage: tacendum mcp --account <name> [--notify-owner] [--ask-owner]',
        );
      }
      // The launch opt-ins are FORKS, not flags threaded through the default
      // path: absent both, the default server is reached through code
      // these features never touched — bit-for-bit, deliberately. The flags are not
      // enforcement (the server's owner binding is); they are what keeps
      // read-only installs read-only. `--ask-owner` composes with
      // `--notify-owner` additively — a notify-only install stays
      // notify-only.
      if (flagBool(args, '--ask-owner')) {
        await runMcpAskServer(flagString(args, '--account'), {
          notify: flagBool(args, '--notify-owner'),
        });
      } else if (flagBool(args, '--notify-owner')) {
        await runMcpNotifyServer(flagString(args, '--account'));
      } else {
        await runMcpServer(flagString(args, '--account'));
      }
      break;
    }
    default:
      // The help text goes to stderr as commentary, NOT inside the error
      // message: under `--json` the message is a field of one object, and
      // embedding thirty lines of prose in it produced valid JSON that no
      // machine consumer could do anything with.
      if (!report.json) process.stderr.write(`${HELP}\n`);
      throw new CliError(
        EXIT.USAGE,
        `unknown command "${sanitizeServerField(command, 32)}" — run: tacendum --help`,
      );
  }

  report.done();
  return EXIT.OK;
}

main().then(
  (code) => {
    // `listen` never resolves; every other command has finished its output by
    // here. Not calling process.exit on success on purpose: an explicit exit
    // can truncate a large stdout write that is still draining.
    if (code !== EXIT.OK) process.exit(code);
  },
  (err: unknown) => {
    // Belt over the boundary sanitizers: server text is cleaned where it
    // enters an error (api.ts, inbound.ts), but THIS is the one surface
    // every uncaught message crosses, ours and the runtime's alike — an
    // undici error quoting a URL, a zod message quoting input. Terminal
    // escapes die here; legitimate multi-line usage prose keeps its lines.
    //
    // NOT `prefixLines`, AND THAT IS A KNOWN RESIDUE RATHER THAN AN OVERSIGHT
    // (an earlier revision sweep). `error: ` is a machine prefix — the July round treated
    // a forged second `error: …` line on stderr as the defect worth fixing —
    // and `sanitizeForTerminal` keeps LF and U+2028/U+2029, so any string that
    // reaches a thrown message can still open a line here. It is not owned per
    // line because the multi-line shape is load-bearing: the hostconfig
    // refusal ends with "change that line yourself to:\n<line>", and prefixing
    // that second line with `error: ` would corrupt the exact text the
    // operator is being told to copy. That exemption is still real and still
    // the only reason this site is shaped this way (hostconfig.ts, the
    // `notify` collision).
    //
    // WHAT THE PREVIOUS VERSION OF THIS NOTE GOT WRONG, recorded because a
    // note that names the wrong gap is worse than no note — the next reader
    // trusts it and stops looking. It said the remaining exposure was
    // `api.ts`'s success-path `.json()` calls. That WAS live (a 2xx whose body
    // is `x\nerror: forged` is quoted back whole by V8's SyntaxError), and it
    // is now closed by `requestJson` there. But it was never the only one, and
    // the one it hid was simpler and louder: `AuthResponse.authToken` is an
    // unrestricted `z.string()`, so a hostile `POST /v1/auth` could answer with
    // a token containing newlines, which registration then handed to the key
    // upload — where NODE's own `Headers.append` refused it with a message
    // QUOTING THE TOKEN BACK, and this line printed a byte-exact
    // `error: forged by the server` at column zero. Nothing in this repository
    // composed that string. Both paths are executed end to end, through the
    // real binary, by test/gate.server-line-forgery.test.ts, and both are now
    // closed at their boundary in api.ts (`checkedSessionToken`,
    // `requestJson`, and the field sanitizer on the transport catch).
    //
    // WHAT REMAINS, stated as narrowly as it was checked. Multi-line messages
    // still reach this line, and two sources of them were examined:
    //  - the hostconfig refusal above, deliberate, and the reason for the
    //    exemption.
    //  - a zod `.parse()` failure on a server response, whose `.message` is a
    //    pretty-printed JSON dump and so is multi-line by construction. Every
    //    line of it is zod's own text: the issues carry the schema's expected
    //    type and path, and the RECEIVED value is not quoted (verified against
    //    this CLI's schemas on zod's current output). So it can put extra lines
    //    on stderr; it cannot put a chosen one there.
    // No claim is made here about any source not on that list. The last note
    // made one, and this is what it cost.
    //
    // A CREDENTIAL CANNOT LEAVE THROUGH THIS LINE EITHER, and that is not a
    // second mechanism: `sanitizeForTerminal` removes every registered
    // credential as of this writing (render.ts, THE CREDENTIAL CHOKEPOINT), so
    // this call — the one surface EVERY uncaught message crosses, ours and the
    // runtime's alike — inherits it without a per-sink belt. That is the whole
    // reason the redaction went inside the sanitizer rather than beside the
    // two sinks that had been noticed: the sink nobody has noticed yet is the
    // one that matters, and it will still call this.
    //
    // …AND THE SINK NOBODY HAD NOTICED WAS THE STRUCTURED ONE, which is worth
    // recording here because this note is where a reader comes to find out
    // what is covered. "Every string crosses a sanitizer" was true of the
    // HUMAN path and false of `--json`: a structured printer calls no
    // sanitizer at all, it calls `JSON.stringify`, and JSON framing answers
    // the injection question while leaving the disclosure one wide open. That
    // is closed at `Reporter.emit` (output.ts), not here; this line still owns
    // only the uncaught-message path, and the `--json` arm below is a separate
    // printer whose `message` is already sanitized above.
    //
    // …AND THE ONE REFUSAL WHOSE REMEDY IS NOT KNOWABLE WHERE IT IS THROWN.
    // `loadProfile` refuses a stored token that cannot be a header value, and
    // the safe advice ("register again — it signs in") and the destructive one
    // ("do NOT register — it would mint a new account and strand this one")
    // depend on whether an identity credential RESOLVES on this machine.
    // profile.ts cannot ask that: the resolver is keychain.ts, which imports
    // profile.ts. It answered it by hand instead, and the hand answer
    // disagreed with the real one in both directions — a remedy that tells the
    // operator to do the thing that destroys the account (see the docblock in
    // profile.ts where that probe used to be). So the throw carries the FACT
    // and this line — the single point every CLI failure is printed, human and
    // `--json` alike — attaches the forecast from `registerForecast`, which
    // consults the resolver registration itself uses. One implementation, and
    // it cannot disagree with `doctor`, which renders the same function.
    const raw = err instanceof Error ? err.message : String(err);
    const message = sanitizeForTerminal(
      err instanceof UnusableTokenError
        ? `${raw} ${registerForecast(err.account).advice}`
        : raw,
    );
    const code = exitCodeFor(err);
    // Retire the transient status line first. Without this every interactive
    // failure read as `connecting…error: websocket handshake failed: ...` —
    // the message welded to a line that was never terminated.
    report.done();
    // Errors are stderr, always, so `$(tacendum whoami x)` never captures half
    // a result. Under --json the same failure is one object with the exit code
    // in it, so a caller can branch on the slug rather than on the prose.
    if (report.json) {
      process.stderr.write(
        `${JSON.stringify({ ok: false, error: { code: slugOf(err), exit: code, message } })}\n`,
      );
    } else {
      process.stderr.write(`error: ${message}\n`);
    }
    process.exit(code);
  },
);
