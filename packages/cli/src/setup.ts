import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { renderUnicodeCompact } from 'uqr';
import { apiAuth, apiAuthChallenge, apiIntegrationBind, apiUploadKeys } from './api.js';
import { flagBool, flagCount, flagString, parseArgs } from './args.js';
import { CliError, EXIT } from './exit.js';
import {
  isSetupSurface,
  preflightHostConfig,
  writeHostConfig,
  type HostConfigIo,
  type HostConfigOutcome,
  type SetupSurface,
} from './hostconfig.js';
import { preflightCrewVoice, writeCrewVoice, type VoiceIo, type VoiceOutcome } from './crewvoice.js';
import { attachInbound, type Inbound } from './inbound.js';
import { withFileLockAsync } from './lock.js';
import {
  DEVICE_ID,
  isIdentityChange,
  loadOrGenerateKeys,
  signAuthChallenge,
} from './messaging.js';
import { MessageLog } from './msglog.js';
import type { Reporter } from './output.js';
import {
  isUserId,
  loadProfile,
  normalizeUserId,
  profilePath,
  readProfile,
  saveProfile,
  type Profile,
} from './profile.js';
import { sanitizeForTerminal, sanitizeServerField } from './render.js';
import { sendEncryptedAll, type OutboundMessage } from './send.js';
import { AuthSession } from './session.js';
import { FileStores, writeFileAtomic } from './stores.js';
import { WsClient } from './wsclient.js';

/**
 * `tacendum setup <surface> --name "<display name>"` — the onboarding flow:
 * register an integration keypair, pair it to exactly
 * one owner, send the profile card that makes the operator's chosen name the
 * sender in the app, and register the host's notify hook. Zero server
 * changes: every step is a call an existing command already makes.
 *
 * TWO PAIRING FLOWS, chosen by whether `--owner` was given:
 *
 *  - QR (interactive): print this account's id as a terminal QR, then RUN
 *    THE LISTEN LOOP — the phone scans and sends the FIRST message, which is
 *    an X3DH bootstrap that only a connected listener can receive, so the
 *    CLI must be listening or the pairing message just queues. The sender of
 *    that first decrypted message is the owner.
 *  - agent (`--owner <id>`, unattended): the operator pastes their own id
 *    from the app's my-code screen. No listening needed, because the
 *    OUTBOUND path bootstraps X3DH itself (`sendPairingMessages` below,
 *    same bootstrap `cmdSend` performs) — which is precisely why this is the
 *    one flow an AI agent can complete without a human at the terminal.
 *
 * ORDER OF OPERATIONS is the honesty property: preflight the host-config
 * write FIRST (a missing built artifact or a host config the merge would
 * refuse must refuse before anything is registered), pair BEFORE writing
 * the hook config, and when a late step fails, say exactly which state the
 * machine is in — a setup that half-completes silently is worse than one
 * that refuses.
 */

export const SETUP_USAGE =
  'tacendum setup claude-code|codex|cursor|gemini --name "<display name>" ' +
  '[--owner <id>] [--account <name>] [--seconds N]';

/** How long the QR flow waits for the phone's first message. Long, because a
 * human is installing an app and scanning; bounded, because an ATTENDED
 * terminal is the only way to reach this wait (the TTY check below refuses a
 * headless run before anything is registered) and an attended terminal can
 * still be abandoned mid-scan — the honest end of that is the timeout's
 * "registered but NOT paired" refusal, not a listener that sits forever. */
const QR_WAIT_DEFAULT_SECONDS = 600;

/** The display name's ceiling — `ProfileEnvelope.n` is `.max(40)` in
 * app/src/envelope.ts, and a longer name fails the WHOLE card's parse on the
 * phone, so the name would silently never land. Refused here instead. */
const MAX_DISPLAY_NAME = 40;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Test seams, doctor.ts-style: the flow is worth driving end-to-end against
 * a stub server and a scripted socket, and a test must never touch the real
 * `~/.claude` or wait on a real terminal. */
export interface SetupIo {
  hostConfig?: HostConfigIo;
  voice?: VoiceIo;
  /** The QR flow needs a terminal to show the code on. */
  stderrIsTty?: boolean;
  /** Poll cadence for the QR wait. */
  pollMs?: number;
}

/**
 * The QR payload IS the bare account id — never a URL, never a scheme, never
 * a deep link. Standing product guardrail (the app's
 * reader in app/src/qr.ts rejects URI-shaped payloads outright; Signal's
 * 2025 linked-device QR phishing is why links are dangerous). This function
 * is the ONLY thing allowed to produce a payload for the QR renderer, so the
 * guardrail lives here rather than at whoever calls the renderer.
 */
export function qrPayload(userId: string): string {
  // Canonical ULID, not merely 26 base32 characters (F21): 26 characters
  // hold 130 bits and a ULID is 128, so the spec caps the first character at
  // '7' — the server mints ids as ULIDs and can never mint one above that.
  // `isUserId` deliberately accepts the wider shape (it classifies
  // id-vs-name for ADDRESSES), so the canonical bound is enforced here, at
  // the one producer of QR payloads: a first character past '7' proves the
  // on-disk value is not a server-minted id, and rendering it would put a
  // scannable code for a nonexistent account in front of a phone.
  const id = normalizeUserId(userId);
  if (!isUserId(userId) || !/^[0-7]/.test(id)) {
    // The value is not echoed — it came off a profile this process read, and
    // if that file is mangled its content is nobody's to print.
    throw new CliError(
      EXIT.ERROR,
      'refusing to render a pairing code: the account id on disk is not a ' +
        'canonical 26-character ULID user id',
    );
  }
  return id;
}

/**
 * The profile card that makes `--name` the sender name in the app.
 *
 * Field names confirmed against the two parsers that will read it:
 * `render.ts` (this CLI's own — `tcm === 'profile'`, name from `n`) and
 * `ProfileEnvelope` in app/src/envelope.ts, where `n`, `a` AND `v` are all
 * REQUIRED — a card missing `a` or `v` fails the phone's zod parse and the
 * name never lands. `v` is the sender-clock version; a re-run with a new
 * name mints a larger one, so a renamed integration renames its chat.
 *
 * `tcm` is deliberately the FIRST key: both parsers detect an envelope by
 * the literal prefix `{"tcm":` (ENVELOPE_SENTINEL), and JSON.stringify
 * emits keys in insertion order. The type belongs in packages/shared next
 * to the call envelopes; that lift is deliberately deferred, so the shape is constructed here and checked by test.
 */
export function profileCardBody(displayName: string): string {
  return JSON.stringify({ tcm: 'profile', n: displayName, a: '', v: Date.now() });
}

/** The pairing QR as terminal text. Block characters render in the terminal
 * foreground, so on a dark theme the code arrives inverted — phone decoders
 * (iOS Vision included) read inverted codes, and ecc M plus a 2-module
 * border keeps the 26-character payload comfortably scannable. */
export function renderPairingQr(userId: string): string {
  return renderUnicodeCompact(qrPayload(userId), { ecc: 'M', border: 2 });
}

export async function cmdSetup(argv: string[], report: Reporter, io: SetupIo = {}): Promise<void> {
  const args = parseArgs(argv, { value: ['--name', '--owner', '--account', '--seconds'] });
  if (flagBool(args, '--help')) {
    console.log(`usage: ${SETUP_USAGE}`);
    return;
  }
  const surface = args.positionals[0];
  if (surface === undefined || !isSetupSurface(surface) || args.positionals.length > 1) {
    throw new CliError(EXIT.USAGE, `usage: ${SETUP_USAGE}`);
  }

  const displayName = flagString(args, '--name');
  if (displayName === undefined || displayName === '') {
    throw new CliError(
      EXIT.USAGE,
      `--name is required — it is the sender name your phone will show. usage: ${SETUP_USAGE}`,
    );
  }
  // The name travels inside the profile card AND onto this terminal, so it
  // must survive both: control bytes are refused (not stripped — silently
  // sending a different name than the one typed helps nobody), and anything
  // past the app's 40-char schema bound would fail the card's parse on the
  // phone and never land. NEVER echoed on refusal: `--name "$SECRET"` is a
  // misconfigured variable away, and this error reaches hook and CI logs
  //.
  if (sanitizeForTerminal(displayName) !== displayName) {
    throw new CliError(EXIT.USAGE, 'the display name contains control characters — remove them');
  }
  if (displayName.length > MAX_DISPLAY_NAME) {
    throw new CliError(
      EXIT.USAGE,
      `the display name is longer than ${MAX_DISPLAY_NAME} characters — the app refuses ` +
        'longer ones, so the name would never appear',
    );
  }

  const rawOwner = flagString(args, '--owner');
  if (rawOwner !== undefined && !isUserId(rawOwner)) {
    // Same rule and same silence as cmdPair: the VALUE is not echoed.
    throw new CliError(
      EXIT.USAGE,
      "--owner is not a user id — your id is 26 characters of Crockford base32, on the app's my-code screen",
    );
  }
  const requestedOwner = rawOwner !== undefined ? normalizeUserId(rawOwner) : undefined;

  const account = flagString(args, '--account') ?? surface;
  try {
    profilePath(account); // shape check; throws a plain Error on an illegal name
  } catch (err) {
    throw new CliError(EXIT.USAGE, `--account: ${err instanceof Error ? err.message : 'invalid name'}`);
  }

  const waitSeconds = flagCount(args, '--seconds', QR_WAIT_DEFAULT_SECONDS);

  // PREFLIGHT BEFORE ANY NETWORK OR STATE: every refusal the config write
  // can make — a missing built artifact, an existing config that does not
  // parse, a foreign notify already in codex's one slot — taken now, by
  // running the write's own merge and discarding the result, so those can
  // only ever refuse a setup that has not started, never strand one that
  // already paired. A failure that DEVELOPS between here and the final
  // write (the host rewriting its file, the disk filling) is still
  // possible; the state notes below are the honest answer to those.
  preflightHostConfig(surface, account, io.hostConfig);
  // And the voice target, under the same argument: a refusably-malformed
  // instructions file (markers quoted in the operator's prose, a hand-made
  // skill under our name) must refuse a setup that has not started — the
  // alternative, found by the gate, was a refusal AFTER bind with a second
  // profile card sent on every retry.
  preflightCrewVoice(surface, io.voice);

  // The QR flow's terminal requirement is checked before registering too,
  // for the same reason.
  const stderrIsTty = io.stderrIsTty ?? Boolean(process.stderr.isTTY);
  if (requestedOwner === undefined && !stderrIsTty) {
    throw new CliError(
      EXIT.USAGE,
      'QR pairing needs a terminal to draw the code on. For the unattended flow, pass ' +
        "--owner <id> — your id, from the app's my-code screen.",
    );
  }

  const profile = await ensureIntegrationAccount(account, report);
  const stores = new FileStores(account);
  const auth = new AuthSession(account, stores);

  let owner = profile.ownerUserId;
  if (owner !== undefined && requestedOwner !== undefined && requestedOwner !== owner) {
    throw new CliError(
      EXIT.USAGE,
      `${account} is already paired, and a binding cannot be changed — that is what stops ` +
        'a stolen credential redirecting its own notifications. Use --account <fresh-name> ' +
        'to pair a new integration to a different owner.',
    );
  }

  let action: 'paired' | 'already-paired';
  if (owner !== undefined) {
    action = 'already-paired';
    report.note(`${account} is already paired — refreshing the name card and the host hooks.`);
  } else {
    action = 'paired';
    const target =
      requestedOwner ??
      (await qrPairingFlow({
        account,
        profile,
        stores,
        auth,
        report,
        timeoutMs: waitSeconds * 1000,
        pollMs: io.pollMs ?? 250,
      }));
    if (target === profile.userId) {
      throw new CliError(EXIT.USAGE, 'an integration cannot own itself');
    }
    await bindOwner(account, auth, target);
    try {
      saveProfile({ ...loadProfile(account), ownerUserId: target });
    } catch (err) {
      // F9a: the server binding EXISTS from the line above, so a failed
      // local save (read-only disk, ENOSPC) must say which state the
      // machine is in, not vanish into a bare fs error.
      report.note(
        `state: ${account} is bound to its owner ON THE SERVER, but recording that ` +
          'locally failed, so this machine does not know it is paired. Fix the disk ' +
          'and re-run setup: the server accepts a repeat bind to the same owner ' +
          '(the binding is write-once but idempotent), so the re-run completes the ' +
          'pairing instead of conflicting.',
      );
      throw err;
    }
    owner = target;
    report.note(
      `paired ${account} -> ${sanitizeServerField(target)} — this integration can now ` +
        'message that one person and nobody else, and can be revoked from their phone.',
    );
  }

  // The AuthSession for the send half is constructed AFTER the owner
  // landed on disk. `auth` above had to exist before pairing (the QR listen
  // and the bind need credentials), so its profile snapshot predates
  // `ownerUserId` — and a 401 during the sends would make that session
  // re-mint and save its stale snapshot (session.ts saves `this.profile`
  // under the auth lock), silently ERASING the pairing it just made; the
  // next setup would then retry the write-once server binding. A session
  // whose snapshot includes the owner re-saves the truth.
  const sendAuth = new AuthSession(account, stores);

  // From here on the pairing EXISTS, so every failure must say so — the
  // remaining steps are retryable by re-running setup, which skips straight
  // back here.
  try {
    await sendPairingMessages({
      account,
      stores,
      auth: sendAuth,
      owner,
      displayName,
      surface,
      report,
      // F5: the hello belongs to the FIRST pairing. A re-run resends only
      // the name card (the documented rename path) — re-greeting the owner
      // on every re-run is a duplicate message, not idempotence.
      includeHello: action === 'paired',
    });
  } catch (err) {
    report.note(
      `state: ${account} is registered and PAIRED, but the name card did not go out — ` +
        'the chat may show a raw id instead of the name. Re-run setup to retry; the ' +
        'pairing is kept.',
    );
    throw err;
  }

  let outcome: HostConfigOutcome;
  try {
    outcome = writeHostConfig(surface, account, io.hostConfig);
  } catch (err) {
    report.note(
      `state: ${account} is registered and PAIRED and the name card was delivered, but ` +
        `the ${surface} hook config was NOT written. Re-run setup to retry; nothing ` +
        'else needs to be redone.',
    );
    throw err;
  }

  // The crew-chat voice (spec Task A) rides behind the hook config: both are
  // instruction-surface writes, and a failure here leaves the same
  // retryable state — everything registered, paired, named and hooked, only
  // the voice owed. Cursor has no file the CLI can safely write (its
  // user-level rules live in the settings UI), so `voice.path` is null there
  // and the note points at `tacendum crew voice` instead.
  let voice: VoiceOutcome;
  try {
    voice = writeCrewVoice(surface, io.voice);
  } catch (err) {
    report.note(
      `state: ${account} is registered, PAIRED, named, and the ${surface} hook config is ` +
        'written, but the crew-chat voice was NOT installed. Re-run setup to retry; ' +
        'nothing else needs to be redone.',
    );
    throw err;
  }
  if (voice.path === null && !report.json) {
    report.note(
      `${surface} keeps its rules in its own settings UI — paste the output of ` +
        '`tacendum crew voice` there to teach the agent the chat voice.',
    );
  }

  // What setup may print (F12): the operator's own typed inputs (`account`
  // is shape-checked by profilePath above, `name` refused control bytes
  // above), paths this module chose, and the two ids — which are
  // server-minted, so they cross `sanitizeServerField` even under --json
  // (JSON.stringify escapes C0 but passes DEL and C1 through intact;
  // render.ts records why). The phone's message content is never printed at
  // all — see the muted reporter in qrPairingFlow.
  report.emit(
    {
      ok: true,
      action,
      surface,
      account,
      userId: sanitizeServerField(profile.userId),
      owner: sanitizeServerField(owner),
      name: displayName,
      config: outcome.path,
      configChanged: outcome.changed,
      voice: voice.path,
      voiceChanged: voice.changed,
    },
    `${account} ${action === 'paired' ? 'paired' : 'already paired'} -> ${sanitizeServerField(owner)}; ` +
      `${surface} hooks ${outcome.changed ? 'written to' : 'already current in'} ${outcome.path}`,
  );
  if (!report.json) {
    report.note(
      `done — finish a task in ${surface} and the notification arrives on your phone ` +
        `from "${sanitizeForTerminal(displayName)}".`,
    );
  }
}

/**
 * Register (or adopt) the integration account this setup drives.
 *
 * MIRRORS `cmdRegister` IN main.ts — same lock order (register.lock, then
 * the ratchet lock for exactly the key generation, then auth.lock across
 * challenge/sign/auth with the profile saved BEFORE release, then the key
 * upload), because every line of that ordering is a fixed defect (F1, the
 * revoked-token race, the listener stall — see cmdRegister's comments).
 * The duplication is forced for now: cmdRegister is module-private in
 * main.ts, so it can be neither imported nor edited here. UNIFICATION IS
 * OWED — main.ts should
 * delegate to this function (or both to an extracted registration module).
 */
async function ensureIntegrationAccount(account: string, report: Reporter): Promise<Profile> {
  const stores = new FileStores(account);
  /**
   * -----------------------------------------------------------------------
   * SETUP WILL NOT REGISTER OVER A PROFILE IT COULD NOT READ.
   *
   * This function is the sibling `profile.ts` names by name — "setup.ts asks
   * the same question about the same file" — and it asked it with
   * `tryLoadProfile`, which answers `null` for a profile that merely would
   * not READ. A PROFILE THAT WOULD NOT READ IS NOT A PROFILE THAT IS ABSENT.
   * Null means "there is no profile", so an unreadable one (a mode, an owner,
   * a half-finished write, a synced home that dropped a 0600 file) fell
   * straight through to registration, and `saveProfile` below replaced a
   * recoverable record with one that has no `ownerUserId` — THE OWNER
   * BINDING, and that field alone. The class is NOT lost with it: it is
   * written from the SERVER's answer (`minted.accountClass`, below), never
   * from the file, and this function refuses outright when that answer is not
   * 'integration'. This sentence used to read "and no class", which named a
   * loss that does not happen and so understated which field the operator
   * actually has to get back. Meanwhile the server
   * went on holding the write-once binding, so every server-side check still
   * said the pairing was fine. `chmod` recovers what re-registration
   * destroys; nothing recovers the re-registration.
   *
   * It is worse here than in `cmdRegister`, because this command's other
   * outcome is a QR wait: with the profile already overwritten, a pairing
   * timeout prints "registered, NOT paired, nothing written" — a sentence
   * about a file it had rewritten a minute earlier.
   *
   * REFUSED, NOT PRESERVED, for `cmdRegister`'s reason: copying the bytes
   * aside asks this process to succeed at reading the file in order to save
   * it after failing to read it in order to use it. One EACCES stops both.
   * The remedy names the escape (move it aside) for the operator who really
   * does want a clean registration.
   *
   * BEFORE THE PENDING-MARKER LOGIC, deliberately. The marker decides whether
   * a readable profile may be ADOPTED; it has nothing to say about a file
   * nobody could read, and a state that re-drives registration is exactly the
   * state that would write over it.
   *
   * ABSENT IS NOT UNREADABLE. The first setup on a clean machine reads no
   * file at all and is untouched.
   * -----------------------------------------------------------------------
   */
  const read = readProfile(account);
  if (read.kind === 'unreadable') {
    throw new CliError(
      read.error.exitCode,
      `${read.error.message} Setup would REGISTER this account and REPLACE that file, and with ` +
        "it the only local record of this account's class and the owner it is paired with — " +
        'which is why it stopped instead. Move the file aside if you want a fresh integration.',
    );
  }
  const existing = read.kind === 'ok' ? read.profile : null;
  // F8: profile + identity on disk is NOT proof the registration finished —
  // the profile is deliberately saved BEFORE the key upload (see the
  // ordering comment below), so a 503 from PUT /v1/keys used to leave a
  // state every re-run adopted as complete, permanently skipping the upload
  // — and QR pairing then timed out forever, because a phone cannot X3DH
  // against keys the server never got. The pending marker below is written
  // durably before the profile can land and removed only after the upload
  // succeeds, so a re-run that finds it re-drives the whole registration
  // (idempotent: same keys, same account, a fresh token, and the upload it
  // owes). Accounts registered by `cmdRegister` never have the marker and
  // are adopted as before.
  const uploadPending = join(stores.root, 'setup-keys-upload.pending');
  if (existing !== null && stores.identity.exists() && !existsSync(uploadPending)) {
    if (existing.accountClass !== 'integration') {
      throw new CliError(
        EXIT.USAGE,
        `"${account}" already exists on this machine as an ORDINARY account, and the class ` +
          'is fixed at creation — it can message anyone and cannot be paired. Pass ' +
          '--account <fresh-name> to register a new integration.',
      );
    }
    return existing;
  }

  report.status('registering integration account…');
  const minted = await withFileLockAsync(join(stores.root, 'register.lock'), async () => {
    const keys = await withFileLockAsync(stores.ratchetLockPath(), () => loadOrGenerateKeys(stores));
    // Durable (the default) and BEFORE the auth block that saves the
    // profile: a crash anywhere between the profile save and the upload
    // must leave the marker behind, or the early return above re-adopts a
    // half-registered account.
    writeFileAtomic(uploadPending, 'keys not yet uploaded — setup re-runs the upload\n');
    const auth = await withFileLockAsync(join(stores.root, 'auth.lock'), async () => {
      const { challenge } = await apiAuthChallenge(keys.identityKey);
      const signature = await signAuthChallenge(stores, challenge);
      const minted = await apiAuth(keys.identityKey, challenge, signature, 'integration');
      // Saved inside the auth lock and BEFORE the upload — cmdRegister's
      // ordering, kept for cmdRegister's reasons (a later save would put a
      // revoked token back on disk as the shared value).
      //
      // AND THE BINDING IS CARRIED FORWARD, which for one round it was not.
      // This save is reached on the LEGITIMATE re-drive too — the pending
      // marker means "the upload never finished", not "this is a new account"
      // — so an integration that was already paired had its `ownerUserId`
      // dropped here every time a crash between the profile save and the key
      // upload sent setup back around. With `--owner` the pairing branch
      // below happened to re-bind it (the server's binding is write-once but
      // idempotent), so the loss was survivable; anything that failed in
      // between left the machine unbound against a server that still held the
      // binding, and on the QR path setup draws a code and waits for a phone
      // to re-pair an account that never came unpaired.
      //
      // ON A USERID MATCH ONLY, which is `cmdRegister`'s rule and exists for
      // its reason: a profile that outlived an identity wipe, or a
      // delete-and-re-register that minted a fresh userId, would otherwise
      // donate a dead account's binding to a new one.
      //
      // AND FROM A READ TAKEN HERE, inside the lock this save is happening
      // under — never from `existing`, which is read at the top of this
      // function, BEFORE `register.lock` (an earlier review).
      //
      // Two first-runs for the same account — this command and a cron
      // `register`, two CI steps — both read "no profile". One wins the lock,
      // registers, and is paired, which writes `ownerUserId`. The loser then
      // takes the lock, authenticates as the SAME userId, and saved from its
      // stale `existing = null`: a record with no owner, on a machine where
      // the server still holds the write-once binding. With `--owner` the
      // pairing branch below re-binds and hides it; on the QR path setup goes
      // on to draw a code and wait for a phone to re-pair an account that was
      // paired a second ago, and every failure between the two saves leaves
      // the machine unbound for good.
      //
      // The pre-lock read still decides whether to REGISTER AT ALL (the
      // adoption check above) and what to say; what lands on disk is decided
      // here. UNREADABLE IS STILL REFUSED rather than folded to "absent", for
      // the reason the refusal at the top of this function gives: the file is
      // the only local record of the class and the binding, and a failed read
      // is never evidence that it is gone. A profile whose stored TOKEN is
      // unusable is a READABLE profile and inherits normally — `readProfile`
      // reports it `ok`, with the credential emptied.
      const atSave = readProfile(account);
      if (atSave.kind === 'unreadable') {
        throw new CliError(
          atSave.error.exitCode,
          `${atSave.error.message} This account authenticated, but saving would REPLACE that ` +
            "file and with it the only local record of this account's class and the owner it is " +
            'paired with — which is why setup stopped instead. Move the file aside if you want ' +
            'a fresh integration, then re-run.',
        );
      }
      const existingAtSave = atSave.kind === 'ok' ? atSave.profile : null;
      const inherited = existingAtSave?.userId === minted.userId ? existingAtSave : null;
      saveProfile({
        name: account,
        identityKey: keys.identityKey,
        userId: minted.userId,
        authToken: minted.authToken,
        registrationId: keys.registrationId,
        deviceId: DEVICE_ID,
        ...(minted.accountClass === 'integration' ? { accountClass: 'integration' as const } : {}),
        ...(inherited?.ownerUserId ? { ownerUserId: inherited.ownerUserId } : {}),
      });
      return minted;
    });
    await apiUploadKeys(auth.authToken, keys);
    rmSync(uploadPending, { force: true });
    return auth;
  });

  if (minted.accountClass !== 'integration') {
    // The server is the authority on the class, and it answers 'integration'
    // whenever this call CREATED the account — so an ordinary answer means
    // this keypair already belonged to a human-class account.
    throw new CliError(
      EXIT.USAGE,
      `the server holds "${account}" as an ORDINARY account — the class is fixed at ` +
        'creation, so setup cannot pair it. Pass --account <fresh-name> to register a ' +
        'new integration.',
    );
  }
  return loadProfile(account);
}

/**
 * The reporter the pairing listener renders through: every content surface
 * muted (F12). `attachInbound` is `listen`'s policy, and `listen` PRINTS
 * each decrypted message — on stdout, or as a --json record — which is
 * correct there and a plaintext leak here: during QR pairing the phone
 * speaks first and may open with anything, including a secret, and setup's
 * output goes to hook and CI logs. `note` is muted along with
 * `line` because the inbound path renders peer-supplied text through both
 * (carrier cards go to stderr via `note`). The message itself is still
 * decrypted, spooled and acked under the full inbound policy — only the
 * RENDERING is withheld, and the success note in `qrPairingFlow` points at
 * `tacendum inbox` for reading it.
 */
function contentMutedReporter(report: Reporter): Reporter {
  const muted = Object.create(report) as Reporter;
  muted.line = () => {};
  muted.note = () => {};
  return muted;
}

/**
 * The QR half of pairing: show the code, then BE the listener, because the
 * phone sends the first message and an integration that is not connected
 * receives nothing. The inbound policy is `attachInbound` — the same one
 * `listen` installs, not a re-implementation — so the first message is
 * decrypted, spooled, and acked under every rule that path already enforces.
 *
 * WHO THE OWNER IS is read from what the decrypt PROVED, not from the
 * frame's server-asserted `from`: a successful decrypt TOFU-pins the
 * sender's identity key, so the owner is the one newly pinned peer. Two
 * different accounts messaging inside the window is a refusal, never a
 * guess — the binding is write-once, so guessing wrong is permanent.
 */
async function qrPairingFlow(opts: {
  account: string;
  profile: Profile;
  stores: FileStores;
  auth: AuthSession;
  report: Reporter;
  timeoutMs: number;
  pollMs: number;
}): Promise<string> {
  const { account, profile, stores, auth, report } = opts;
  const before = new Set(stores.identity.pinnedPeers());

  report.note(
    [
      '',
      'pair with your phone:',
      '  1. in Tacendum on your phone, open your chats and choose "scan code"',
      `  2. scan the code below — its payload is this integration's bare account id`,
      '  3. send any message in the chat that opens; the FIRST message pairs this',
      '     integration to you, permanently',
      '',
      renderPairingQr(profile.userId),
      `  (no camera handy? on the phone, note your own id on the my-code screen and`,
      `   re-run: tacendum setup … --owner <that id>)`,
      '',
    ].join('\n'),
  );

  const log = new MessageLog(account);
  log.applyRetention();
  const ws = new WsClient();
  // Attached BEFORE the dial, as every consumer does: the drain lands in the
  // first milliseconds after open and `ws` does not buffer.
  const inbound = attachInbound({
    name: account,
    userId: profile.userId,
    stores,
    ws,
    // The phone's first message is not ours to render — see
    // `contentMutedReporter` (F12).
    report: contentMutedReporter(report),
    log,
    consume: true,
  });
  report.status('connecting…');
  await ws.connect(auth, 'listen');
  report.note(
    `waiting up to ${Math.round(opts.timeoutMs / 1000)}s for the first message — ` +
      'nothing is bound until it arrives (ctrl-c aborts safely)…',
  );

  try {
    const deadline = Date.now() + opts.timeoutMs;
    for (;;) {
      await sleep(opts.pollMs);
      await inbound.settled();
      if (inbound.consumed > 0) {
        const pinned = stores.identity.pinnedPeers().filter(isUserId);
        const fresh = pinned.filter(p => !before.has(p));
        const candidates = fresh.length > 0 ? fresh : pinned;
        if (candidates.length === 1) {
          report.note(
            'the pairing message arrived — its content is deliberately not shown ' +
              `here (setup output reaches logs); read it with: tacendum inbox ${account}`,
          );
          return normalizeUserId(candidates[0] as string);
        }
        throw new CliError(
          EXIT.ERROR,
          candidates.length === 0
            ? 'a message arrived but no well-formed account pinned an identity — ' +
                "re-run with --owner <id> (the id on your phone's my-code screen)"
            : `${candidates.length} different accounts messaged during pairing — refusing to ` +
                "guess which is yours. Re-run with --owner <id> from your phone's my-code screen.",
        );
      }
      if (Date.now() >= deadline) {
        throw new CliError(
          EXIT.TIMEOUT,
          `no message arrived within ${Math.round(opts.timeoutMs / 1000)}s — the account is ` +
            'registered but NOT paired and nothing was written. Re-run setup to show the ' +
            'code again, or pass --owner <id> to pair without scanning.',
        );
      }
    }
  } finally {
    ws.close();
  }
}

/**
 * Bind this integration to its owner — write-once on the server, and the
 * entire reason an agent may hold this credential (see cmdPair in main.ts,
 * whose server-code mapping this mirrors; same forced duplication, same
 * unification owed, as `ensureIntegrationAccount` documents).
 */
async function bindOwner(account: string, auth: AuthSession, owner: string): Promise<void> {
  try {
    await apiIntegrationBind(auth, owner);
  } catch (err) {
    if (err instanceof CliError && err.code === 'owner_conflict') {
      throw new CliError(
        EXIT.ERROR,
        `${account} is already bound to an owner on the server, and a binding cannot be ` +
          'changed. Register a new integration (--account <fresh-name>) if it needs a ' +
          'different owner.',
      );
    }
    if (err instanceof CliError && err.code === 'unknown_owner') {
      throw new CliError(
        EXIT.USAGE,
        'the server knows no account with that owner id. It must be YOUR id, from the ' +
          "app's my-code screen — not the integration's own id.",
      );
    }
    if (err instanceof CliError && err.code === 'not_integration') {
      throw new CliError(
        EXIT.USAGE,
        `the server holds ${account} as an ordinary account, so it cannot be paired. ` +
          'Pass --account <fresh-name> to register a new integration.',
      );
    }
    throw err;
  }
}

/**
 * The one-shot outbound half: profile card, then — on a first pairing only
 * — the hello, on one socket. A re-run sends just the card (`includeHello:
 * false`): re-sending the card is the documented rename path, but the hello
 * is conversation, and greeting the owner again on every re-run is a
 * duplicate message, not idempotence (F5).
 *
 * THE WIRE SEQUENCE IS `sendEncryptedAll`'s (send.ts) — the one owner of
 * connect-before-ratchet — with both messages on its ONE socket. This
 * function used to run the sequence itself, and its copy had the bootstrap
 * BEFORE the dial: every refused socket cost the owner a one-time prekey
 * and wrote a session, so repeated failed setups burned the account's
 * prekeys against a peer they never reached. In the QR flow the inbound
 * bootstrap already built the session, so `sendEncryptedAll` finds it and
 * just encrypts; in the agent flow it bootstraps X3DH itself, post-connect,
 * exactly as cmdSend does.
 *
 * What is setup's own here: the message list (the card is a CARRIER —
 * `notify: false`, it renames a chat rather than saying anything — and the
 * hello notifies normally), the status wording, the F12 inbound policy, and
 * the identity-change refusal naming `tacendum trust`.
 */
async function sendPairingMessages(opts: {
  account: string;
  stores: FileStores;
  auth: AuthSession;
  owner: string;
  displayName: string;
  surface: SetupSurface;
  report: Reporter;
  includeHello: boolean;
}): Promise<void> {
  const { account, stores, auth, owner, report } = opts;

  const messages: OutboundMessage[] = [
    { body: profileCardBody(opts.displayName), notify: false },
  ];
  if (opts.includeHello) {
    messages.push({
      body:
        `Paired: "${opts.displayName}" (${opts.surface} on this machine) can now send ` +
        'task notifications to this chat — and to nobody else.',
    });
  }

  let inbound: Inbound | undefined;
  try {
    await sendEncryptedAll({
      stores,
      auth,
      to: owner,
      messages,
      events: {
        onSocket: ws => {
          inbound = attachInbound({
            name: account,
            userId: auth.userId,
            stores,
            ws,
            report,
            log: new MessageLog(account),
            consume: false,
          });
        },
        connecting: () => report.status('sending the name card…'),
        fetchingBundle: () => report.status('opening a session (X3DH/PQXDH)…'),
        // Let the acks the inbound policy already started finish before the
        // socket closes, as the previous inline copy did.
        beforeClose: () => inbound?.settled() ?? Promise.resolve(),
      },
    });
  } catch (err) {
    if (isIdentityChange(err)) {
      throw new CliError(
        EXIT.SAFETY,
        `SAFETY NUMBER CHANGED for the owner — refusing to send. Verify out of band, ` +
          `then: tacendum trust ${account} ${owner}`,
      );
    }
    throw err;
  }
  inbound?.report();
}
