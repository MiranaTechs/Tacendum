import { mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './atomic-write.js';
import { clientDir, tacendumHome } from './config.js';
import { CliError, EXIT } from './exit.js';
import { guardCredential } from './render.js';

/**
 * Per-client profile: server identity + auth token. Lives alongside the
 * protocol stores under `$TACENDUM_HOME/<name>/profile.json` (0600).
 */
export interface Profile {
  name: string;
  /**
   * The account's identity public key, b64. It
   * replaces `phone` — there is no phone number any more, and this is the
   * thing the `userId` is actually bound to.
   *
   * Recorded for display and for diagnosis, NOT as a credential: the private
   * half lives in `identity.json` under the same directory and is the only
   * thing that can mint a token. A copy here is harmless (it is public) and
   * makes a profile/store mismatch visible instead of silent.
   */
  identityKey: string;
  userId: string;
  authToken: string;
  registrationId: number;
  deviceId: number; // always 1 in the local milestone (no multi-device)
  /**
   * Set at birth for an integration account, absent for
   * an ordinary one. Recorded because `GET /v1/me` returns only a userId, so
   * this is the only way the CLI can tell you which kind of account you are
   * holding — and the two behave very differently in a way that is otherwise
   * invisible until a send is refused.
   */
  accountClass?: 'integration';
  /**
   * The owner this integration is bound to, once `pair` has succeeded.
   *
   * LOCAL BOOKKEEPING, NOT AUTHORITY. The server decides: it refuses any frame
   * from an integration addressed anywhere but its bound owner, and it will go
   * on refusing after an owner revokes the binding even though this field still
   * says otherwise. Used to decide what the CLI can usefully OFFER — chiefly
   * whether the MCP server advertises a send tool at all — never to decide what
   * is permitted.
   *
   * OWNER GROUPING CHANGES NOTHING HERE: the binding
   * stays write-once to this ONE ULID, forever. When the owner links devices into
   * a group, the SERVER resolves this ULID to the owner's whole group at
   * predicate time, so notify/ask and sends may reach the human on whichever
   * of their devices is in hand — without this field ever changing, and
   * without the CLI learning or storing any sibling ULID. If the bound device
   * amicably unlinks, the binding rides with it (this agent belongs to that
   * now-standalone account and loses group reach); if the bound device is
   * revoked as lost/stolen, the server tombstones this agent's account in the
   * same transaction and every call here starts refusing — re-pair a fresh
   * integration from any surviving device.
   */
  ownerUserId?: string;
}

/**
 * ---------------------------------------------------------------------
 * THE RULES ABOUT THE CREDENTIAL THIS FILE STORES.
 *
 * They live here, with the token, rather than beside either of the two
 * places that ask them. api.ts owns presenting a credential and doctor.ts
 * owns reporting on one; both import from here, and neither owns what a
 * credential IS.
 *
 * The direction matters for a reason that is not taste. These predicates
 * were first written in api.ts, and `loadProfile` — which every command
 * calls before it does anything — therefore imported the transport. Three
 * test files mock api.js partially, so loading a profile began throwing
 * `No "isHeaderSafeToken" export is defined on the "../src/api.js" mock`
 * in tests that have nothing to do with the network. A module on every
 * command's critical path must not depend on the most-mocked module in
 * the package; this file imports node:fs, config, exit and render, all of
 * which are leaves.
 * ---------------------------------------------------------------------
 */

/**
 * WHAT A SESSION TOKEN IS ALLOWED TO BE — visible ASCII, no spaces, bounded.
 *
 * `AuthResponse.authToken` is a plain `z.string()` in packages/shared, and a
 * token is the one server value this client PUTS BACK ON THE WIRE: it goes
 * into an `authorization` header on every authenticated route. Node validates
 * headers, and `Headers.append` reports an invalid one by QUOTING THE VALUE
 * BACK — newlines intact. So a server answering `POST /v1/auth` with
 * `authToken: "x\nerror: forged by the server\nx"` never sent a byte of it
 * anywhere, and still wrote `error: forged by the server` at column zero on
 * this program's stderr, by way of the key upload's failure and the top-level
 * `error:` print. Reproduced end to end through the real binary
 * (test/gate.server-line-forgery.test.ts).
 *
 * CHECKED WHERE THE RESPONSE IS PARSED, not at the header — api.ts still does
 * that, and it is still the right place to catch a hostile server. What it is
 * NOT is sufficient, and the sentence that used to end this paragraph ("one
 * check at the boundary is the whole of it, and the value never becomes a
 * stored fact") was false in both halves: the value becomes a stored fact on
 * the very next line of `cmdRegister`, and the mint is therefore one boundary
 * of two. `loadProfile` below is the other. See the next docblock.
 *
 * 1024 rather than the 43 the server actually mints (`randomBytes(32)` as
 * base64url): pinning the current format would turn a token-format change into
 * a client outage, and the missing property was never "is this base64url" — it
 * was "can this be a header value at all". `!`–`~` is exactly the printable,
 * space-free ASCII an opaque credential can honestly need, and it is what RFC
 * 7230 lets a field value be built from.
 *
 * The refusal QUOTES NOTHING. Whatever shape it arrived in, this string is a
 * credential, and the log-hygiene rule does not have an exception for a malformed
 * one.
 */
const HEADER_SAFE_TOKEN = /^[!-~]{1,1024}$/;

/**
 * The same grammar, asked as a question, for the OTHER way a token reaches a
 * header — and there are two, which is what the docblock above got wrong.
 *
 * "One check at the boundary is the whole of it" is true only if the mint is
 * the only boundary. It is not. The token does not stay in this process: it is
 * written to profile.json and read back by every later command, so a profile
 * written by a build that PREDATES this check holds whatever that build was
 * handed, and no amount of guarding the mint reaches it. `main.ts` saves the
 * profile before the key upload, so a half-finished registration on such a
 * build is enough to leave one behind permanently.
 *
 * Exported rather than re-derived: profile.ts refuses on load and doctor.ts
 * reports on load, and a rule about what a credential may be must have one
 * spelling. Three regexes would be three chances to disagree.
 */
export function isHeaderSafeToken(token: string): boolean {
  return HEADER_SAFE_TOKEN.test(token);
}

/**
 * WHERE THE "DOES THIS TEXT NAME THE SECRET" PREDICATE WENT, and why it is
 * gone rather than moved.
 *
 * `quotesCredential` lived here and was asked at two sinks — the transport
 * catch in api.ts and doctor's `me.json()` catch — each of which then withheld
 * its whole message. Both of those are EXCEPTION paths, and the rule is not about exceptions: a 500 whose `detail` is the bearer, a
 * content-type header that is the bearer, and a `/v1/me` answering with the
 * bearer as its `userId` all reached stderr and the `--json` error object
 * without any exception being involved. A predicate answered per sink is a
 * predicate that will be forgotten at sink N+1, and it was.
 *
 * It is replaced by `redactCredentials` in render.ts, applied INSIDE the two
 * sanitizers every server- and peer-influenced string in this package already
 * crosses. What survives here is this file's real responsibility — knowing
 * what a credential IS, and telling the chokepoint about one whenever the
 * value crosses this boundary (see `loadProfile`).
 */

export function profilePath(name: string): string {
  return join(clientDir(name), 'profile.json');
}

/**
 * ---------------------------------------------------------------------------
 * WHERE THE "IS THERE AN IDENTITY KEY ON THIS MACHINE" PROBE WENT, and why it
 * is gone rather than fixed.
 *
 * `identityIsOnDisk` stood here for one round: an `existsSync` on
 * identity.json plus a hand-parse of `credential-backend.json`, used to pick
 * which of two remedies the malformed-token refusal below prints — and the two
 * differ in whether FOLLOWING THEM DESTROYS THE ACCOUNT.
 *
 * THE DEFECT WAS NOT A BUG IN THE PROBE. It was that the probe existed. The
 * CLI already answers this question operationally, on the path the remedy is
 * about: `cmdRegister` asks `stores.identity.exists()`, which is identity.json
 * or `readCredential(name)` — keychain.ts, the module that owns the marker
 * vocabulary, the backend order, the legacy coordinates and the
 * absent-versus-failed distinction. A second answer to one operational
 * question does not converge with the first; it drifts. Within one round this
 * one had drifted in BOTH directions at once:
 *
 *   - a marker naming a backend this build does not know ("not `file`,
 *     therefore the key is somewhere I cannot look") read as PRESENT. The real
 *     resolver rejects the name, falls through to a file-preferred read, finds
 *     nothing — and registration minted a replacement account under a message
 *     promising that the owner binding would survive.
 *   - a LOST marker beside a healthy keychain item read as ABSENT, and the
 *     message said "Do NOT register" about the one action that finds the item
 *     and signs in safely.
 *
 * The decision now lives in doctor.ts (`registerForecast`), which can consult
 * `readCredential` — this file cannot, because keychain.ts imports `profilePath`
 * from here and the cycle would be real. That direction is right on its own
 * merits: knowing what a credential IS is this file's job (see the docblock
 * above), knowing WHERE this machine's credential lives is keychain.ts's, and
 * reporting on either is doctor.ts's. `main.ts` attaches the advice at the one
 * point every CLI failure is printed, so the refusal below states the FACT and
 * never the forecast, and there is exactly one implementation of each.
 * ---------------------------------------------------------------------------
 */

/**
 * Write the profile ATOMICALLY: temp file in the same directory, then rename.
 *
 * This used to be a bare `writeFileSync`, which was defensible while the file
 * was written exactly once, by `register`. It is not any more — C3 rewrites it
 * on every token renewal and `AuthSession.mint()` reads it back to adopt
 * another process's token, so a reader that lands inside the truncate/write
 * window gets a `JSON.parse` SyntaxError and a completely unexplained exit 1
 * on a machine where nothing is wrong. `rename` within one directory is atomic
 * on every filesystem this runs on, so a reader sees either the old profile or
 * the new one and never a half of either.
 *
 * The mode goes on the temp file, because `rename` keeps the source's
 * permissions — writing 0600 after the rename would leave a window in which
 * the auth token is world-readable.
 *
 * Through `writeFileAtomic` since the external scan: this
 * function carried its own inline copy of the temp-and-rename pattern, with
 * the same predictable `<target>.<pid>.tmp` staging name and a plain
 * `writeFileSync` that would have FOLLOWED a symlink planted there. The
 * shared writer stages under a random suffix with O_EXCL|O_NOFOLLOW and
 * cleans its temp up on failure — see atomic-write.ts for the argument.
 * 'crash-consistent' pins exactly the durability this write always had (no
 * data fsync, no directory fsync): the profile is a token cache the server
 * can mint again, and C3 rewrites it on every renewal, so buying F_FULLFSYNC
 * latency here would be paying for a guarantee nothing needs. Atomicity is
 * what the reader (`AuthSession.mint()` adopting another process's token)
 * depends on, and the rename alone provides it.
 */
export function saveProfile(profile: Profile): void {
  const dir = clientDir(profile.name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileAtomic(
    profilePath(profile.name),
    JSON.stringify(profile, null, 2),
    { mode: 0o600 },
    'crash-consistent',
  );
}

/**
 * The refusal `loadProfile` makes when the STORED TOKEN cannot be a header
 * value — carrying everything about the account that is still true.
 *
 * A REFUSAL MUST NOT COST THE OPERATOR STATE THE REFUSAL WAS NOT ABOUT, and
 * the previous round's remedy did exactly that. `tryLoadProfile` turned this
 * refusal into `null`, `null` means "there is no profile", and `cmdRegister`
 * inherits the account's class and its `ownerUserId` from the profile it finds
 * — so a bound integration whose token an older build wrote came back from a
 * re-registration locally UNBOUND. The server's binding is write-once and was
 * never touched; only this machine forgot, which is the worst kind of failure
 * to diagnose because every server-side check says the pairing is fine. The
 * MCP surface then stops offering a send tool, and the remedy the refusal
 * printed ("register this account again") never mentioned `pair`.
 *
 * The answer is not to soften the refusal — a token that cannot be presented
 * genuinely cannot be presented — but to make it DISTINGUISHABLE, so a caller
 * that only wanted the account's facts can have them. `profile` therefore
 * carries the whole record with `authToken` EMPTIED: absent is not malformed
 * (see `loadProfile`), a falsy token composes no header at all, and a caller
 * that goes on to make a request gets the server's honest 401 rather than
 * this machine's forgery of one.
 */
export class UnusableTokenError extends CliError {
  readonly profile: Profile;
  /**
   * The account this refusal is about — CARRIED, NEVER PRINTED. `main.ts`
   * needs it to ask `registerForecast` what re-registering would actually do
   * here; nothing may put it in the message (this file's other refusal
   * explains why a client name is never safe to echo).
   */
  readonly account: string;
  constructor(message: string, profile: Profile, account: string) {
    super(EXIT.AUTH, message);
    this.name = 'UnusableTokenError';
    this.profile = profile;
    // The ARGUMENT, not `profile.name`: the record is untrusted JSON off disk
    // and a `name` field that disagrees with the directory it was read from
    // would send the forecast looking at a different account's credential.
    this.account = account;
  }
}

/**
 * The profile, or null when there is not a readable one.
 *
 * For the callers that are ASKING rather than requiring — a returning sign-in
 * wanting to carry forward what it already knew, a status line wanting to say
 * "unbound". A missing or corrupt profile is an answer to those questions, not
 * an error, and `loadProfile`'s throw would turn a re-registration on a
 * half-installed account into an unexplained exit.
 *
 * A PROFILE WITH AN UNUSABLE TOKEN IS A READABLE PROFILE. That distinction is
 * the whole of an earlier regression: this function used to answer `null`
 * for it, which is a lie about the file on disk and cost a bound integration
 * its binding on the very command the refusal told the operator to run. The
 * credential is emptied on the way out (`UnusableTokenError`), so nothing
 * downstream can present what was refused, and everything downstream that
 * asked about the ACCOUNT still gets a true answer.
 */
export function tryLoadProfile(name: string): Profile | null {
  // Through `readProfile`, so the "is there a record" answer and the
  // three-state answer are one read of one file rather than two predicates
  // that can disagree. The collapse to `null` happens HERE, in the function
  // whose contract is a null — never inside the thing callers ask when the
  // difference between absent and unread decides whether they may write.
  const read = readProfile(name);
  return read.kind === 'ok' ? read.profile : null;
}

/**
 * The account's FACTS, for the callers that never touch its credential.
 *
 * `resolveRecipient` and `resolvePeerUserId` read a peer's profile off this
 * disk for exactly one field — the userId — and a peer whose stored token is
 * unusable would otherwise make addressing them fail with a refusal about a
 * credential this process was never going to present. Same rule as
 * `tryLoadProfile`'s, from the other end: the refusal is about the token, so
 * it may cost the token and nothing else. Absence and corruption still throw,
 * because those really are "there is no such account".
 */
function loadProfileFacts(name: string): Profile {
  try {
    return loadProfile(name);
  } catch (err) {
    if (err instanceof UnusableTokenError) return err.profile;
    throw err;
  }
}

/**
 * The account names that exist under $TACENDUM_HOME.
 *
 * Safe to print, unlike the argument that failed to resolve: every entry here
 * is a directory this CLI created for an account it registered, so none of
 * them can be a secret a caller passed by mistake.
 */
function listAccountNames(): string[] {
  try {
    return readdirSync(tacendumHome(), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((n) => existsSync(join(tacendumHome(), n, 'profile.json')))
      .sort();
  } catch {
    return [];
  }
}

/**
 * An OS error code, or nothing — the only part of a raw `fs` failure that may
 * be repeated.
 *
 * Node's own message embeds the PATH it failed on, and this file's paths are
 * built from the account name (`clientDir`), so `EACCES: permission denied,
 * open '<home>/<name>/profile.json'` is the classic log leak wearing a diagnosis.
 * `stores.ts` settled this shape for identity.json; the profile is the same
 * file one directory over and takes the same treatment. The code is
 * shape-checked so an exotic error object cannot smuggle prose through the
 * slot.
 */
function errnoOf(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && /^E[A-Z0-9]{1,16}$/.test(code) ? code : 'unreadable';
}

/** The file's bytes, or OUR refusal — never the runtime's, for `errnoOf`'s
 * reason. */
function readProfileBytes(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    throw new CliError(
      EXIT.ERROR,
      `this account's profile.json could not be read (${errnoOf(err)}) — the account is not ` +
        'gone, the file is unreadable. Fix the permissions or restore the file; nothing here ' +
        'will overwrite it in the meantime.',
    );
  }
}

/**
 * The record, or a refusal CARRYING NOT ONE BYTE OF THE FILE.
 *
 * A bare `JSON.parse` stood here, and V8 reports a bad document by QUOTING its
 * input: `Unexpected token 'Z', "Zq3Rk8Xv1T"... is not valid JSON` is ten
 * characters of whatever the file starts with. This file holds a session
 * token. A profile a crash truncated mid-token, or one an older build wrote
 * with the bearer unquoted, therefore put a credential fragment into an error
 * message — and that message travels: `tryLoadProfile` is not on this path,
 * `main.ts` prints it at the single failure point, and the redaction registry
 * is EMPTY at that moment because the very call that fills it is the line
 * below this one (render.ts, THE CREDENTIAL CHOKEPOINT).
 *
 * Ordering the two calls the other way cannot fix it — there is nothing to
 * register until the document parses — so the parse error is replaced instead.
 * The DIAGNOSIS survives intact: a reader learns the profile is not valid
 * JSON, which is the whole of what V8's quotation added.
 */
function parseProfileBytes(text: string): Profile {
  try {
    return JSON.parse(text) as Profile;
  } catch {
    // The caught error is DISCARDED, never rethrown and never interpolated —
    // `stores.ts` `parseCredential`'s rule, for the same reason and about the
    // same class of file.
    throw new CliError(
      EXIT.ERROR,
      "this account's profile.json is not valid JSON — it is truncated or corrupt. Its " +
        'contents are not quoted here: the file holds this account\'s session token. Restore ' +
        'it from backup, or move it aside and register the account again.',
    );
  }
}

/**
 * ---------------------------------------------------------------------------
 * THE THREE ANSWERS A PROFILE READ HAS, and why "null" was never one of them.
 *
 * `tryLoadProfile` collapses everything that is not a record into `null`, and
 * every caller reads that null as THERE IS NO PROFILE. Two of the three states
 * are not that:
 *
 *   absent      — nothing on disk. "No profile" is true.
 *   unreadable  — a file IS there and this process could not turn it into a
 *                 record (EACCES, a truncated write, a corrupt document). The
 *                 profile is not gone; it is unread. Anything that treats this
 *                 as absence is about to make a decision on evidence it does
 *                 not have.
 *   ok          — a record, with `tokenUsable` saying whether its credential
 *                 can be presented (the `UnusableTokenError` split: absent is
 *                 not malformed, and a refusal about the token may cost the
 *                 token and nothing else).
 *
 * WHAT THE COLLAPSE COST, exactly, and it is not a wording problem. With a
 * paired integration's profile temporarily unreadable, `doctor` reported "no
 * profile" and recommended registration; `cmdRegister` asked `tryLoadProfile`,
 * got `null`, inherited nothing, and rewrote the file WITHOUT `ownerUserId` —
 * destroying the only local record of a binding that was still perfectly
 * recoverable by fixing a file mode. The remedy was the mechanism of the
 * damage.
 *
 * Callers that genuinely only want "is there a record" keep `tryLoadProfile`
 * and are unchanged. Callers that are about to WRITE, or to tell an operator
 * what a write would do, must ask this one.
 * ---------------------------------------------------------------------------
 */
export type ProfileRead =
  | { kind: 'ok'; profile: Profile; tokenUsable: boolean }
  /** No file. `error` is the refusal `loadProfile` makes, ready to rethrow. */
  | { kind: 'absent'; error: CliError }
  /** A file that would not read. `error` carries this file's own prose only. */
  | { kind: 'unreadable'; error: CliError };

export function readProfile(name: string): ProfileRead {
  try {
    return { kind: 'ok', profile: loadProfile(name), tokenUsable: true };
  } catch (err) {
    // A REFUSAL ABOUT THE TOKEN IS A READABLE PROFILE, and the record it
    // carries is the account's facts with the credential emptied.
    if (err instanceof UnusableTokenError) {
      return { kind: 'ok', profile: err.profile, tokenUsable: false };
    }
    const error =
      err instanceof CliError
        ? err
        : // Nothing else should reach here — every throw on that path is this
          // file's — but composing an answer must never be the thing that
          // throws, and a foreign object's message is not ours to repeat.
          new CliError(EXIT.ERROR, "this account's profile.json could not be read");
    let there = false;
    try {
      there = existsSync(profilePath(name));
    } catch {
      there = false; // an illegal account name has no profile to be unreadable
    }
    return there ? { kind: 'unreadable', error } : { kind: 'absent', error };
  }
}

export function loadProfile(name: string): Profile {
  const path = profilePath(name);
  if (!existsSync(path)) {
    // USAGE, not ERROR: no amount of retrying an unregistered client name
    // helps, and a cron wrapper that distinguishes "misconfigured" from
    // "transient" is the entire reason the code table exists (C5).
    // THE NAME IS NOT ECHOED, and this is the fourth file to learn that.
    //
    // Every account-taking command routes through here, so `tacendum whoami
    // "$SECRET"` — a misconfigured variable, the same confusion that puts a
    // body in the recipient slot — printed that secret to stderr and into
    // hook and CI logs. Found by harness.canary.test.ts, which runs every
    // command with a canary in every argument position; three reviewers had
    // read this line without seeing it, because it looks like it is echoing a
    // client name and usually is.
    //
    // What replaces it is strictly MORE useful: the accounts that DO exist.
    // Those are directory names this CLI created, so they are provably not
    // secrets, and a typo is easier to see next to the real list than quoted
    // back on its own.
    const known = listAccountNames();
    const suffix =
      known.length > 0
        ? ` This machine has: ${known.join(', ')}.`
        : ' No accounts are registered on this machine yet.';
    throw new CliError(
      EXIT.USAGE,
      `no such account on this machine — register it first (tacendum register <name>).${suffix}`,
    );
  }
  const profile = parseProfileBytes(readProfileBytes(path));
  // THE CHOKEPOINT LEARNS ABOUT IT BEFORE ANYTHING ELSE HAPPENS TO IT.
  //
  // This is one of the two moments a credential enters this process (the other
  // is the mint, api.ts `checkedSessionToken`), and it is the moment BEFORE
  // the refusal below — deliberately, because the refusal path is precisely
  // where a malformed token used to be quoted back. Registering here means
  // that whatever text later names this value, composed by us or by the
  // runtime, is redacted at the sanitizers rather than at some sink somebody
  // remembered. See render.ts, THE CREDENTIAL CHOKEPOINT.
  //
  // …AND IT IS NOT THE FIRST THING THAT CAN THROW WITH THE FILE'S BYTES IN
  // ITS HAND, which is why the two lines above are functions now. `JSON.parse`
  // ran HERE, ahead of this call, so a profile an older build half-wrote — or
  // a legacy one holding an unquoted bearer — produced a V8 SyntaxError
  // quoting TEN characters of the file, and `main.ts` printed it while this
  // registry was still empty. Ten characters is above the eight-character
  // disclosure threshold this package holds itself to.
  // `parseProfileBytes` refuses to let any file byte into a parse error at
  // all, so the ordering of this call stops being load-bearing.
  guardCredential(profile.authToken);
  // THE TOKEN IS CHECKED WHERE IT IS LOADED, not only where it was minted.
  //
  // api.ts checks the token `POST /v1/auth` answers with, on the reasoning
  // that one check at the boundary is the whole of it. That reasoning has a
  // hole the size of this file: the value does not stay in that function, it
  // is written HERE and read back by every later command, so a profile
  // written by a build that predates the mint check is a permanent supply of
  // exactly the string the mint check exists to refuse. `main.ts` saves the
  // profile BEFORE the key upload, so half a registration on such a build is
  // enough to leave one on disk forever.
  //
  // WHAT IT COST: Node validates header values and reports an invalid one by
  // QUOTING IT BACK, so a stored `LEGACY_SECRET\nTAIL` reached stderr and the
  // `--json` error object as `Bearer LEGACY_SECRET TAIL` — the credential
  // itself — misfiled as a network fault. An error may never reproduce a
  // credential, and the surest way to keep one out of an
  // error message is for it never to reach the header that composes it.
  //
  // AUTH, not USAGE or ERROR: this is the "credentials are dead, a human must
  // re-pair" case exactly (C5) — nothing about the command line is wrong, and
  // no retry can help, so a cron wrapper needs the code that means "stop and
  // page someone" rather than the one that means "try again".
  //
  // ABSENT IS NOT MALFORMED, and only the malformed case is refused here. A
  // missing or empty token cannot reach a header at all: api.ts omits the
  // authorization header for a falsy bearer, and the server's 401 is a
  // truthful, unambiguous answer. Refusing it here would turn a diagnosable
  // state into a dead end for no security gain.
  //
  // THE TOKEN IS NOT ECHOED, and neither is the account name — this file's
  // other refusal explains why the name is never safe to quote back, and a
  // malformed credential is not the moment to make an exception for either.
  //
  // AND IT COSTS THE TOKEN, NOT THE ACCOUNT. The refusal is `UnusableTokenError`
  // rather than a bare CliError, and it carries the record with the credential
  // emptied, because the previous shape of this line destroyed state it was
  // never about: `tryLoadProfile` read the refusal as "no profile", and the
  // re-registration the remedy names then wrote a profile with no
  // `ownerUserId`, silently unbinding a paired integration on this machine.
  // The remedy below is now the WHOLE remedy — nothing else is required, and
  // it must stay that way or this sentence has to grow.
  //
  // …AND THIS FILE NO LONGER SAYS WHAT THE REMEDY IS. It says what is WRONG,
  // which is the part it knows: a stored token that cannot be a header value.
  //
  // What to DO about it depends on whether an identity credential resolves on
  // this machine, and the previous round answered that here, by hand, with a
  // file check and a marker parse — a second implementation of a question
  // `cmdRegister` already answers through `stores.identity.exists()` /
  // `readCredential`. It disagreed with the real resolver in both directions
  // within one round (see the docblock where that probe used to be), and a
  // remedy that disagrees with what will happen is worse than no remedy: this
  // is the message an operator follows.
  //
  // The forecast is composed by `registerForecast` (doctor.ts, which can reach
  // keychain.ts without a cycle) and attached by `main.ts` at the single point
  // every CLI failure is printed. The refusal is still the WHOLE remedy — it
  // simply gets the operative half from the one place that can compute it.
  if (typeof profile.authToken === 'string' && profile.authToken !== '' &&
      !isHeaderSafeToken(profile.authToken)) {
    throw new UnusableTokenError(
      'the stored session token for this account cannot be presented as an HTTP header, so ' +
        'nothing was sent. It was written by an older build that did not check the value, and ' +
        'it is not echoed here: a credential must never appear in an error.',
      { ...profile, authToken: '' },
      name,
    );
  }
  return profile;
}

/** Resolve a peer's userId from their local store dir (same-machine testing).
 * Through `loadProfileFacts`: this reads the PEER's credential off disk and
 * presents none of it, so a peer whose token an older build wrote is still an
 * addressable account. */
export function resolvePeerUserId(peerName: string): string {
  return loadProfileFacts(peerName).userId;
}

/**
 * A server-minted account id: 26 characters of Crockford base32, the ULID
 * alphabet with I, L, O and U removed.
 *
 * CASE-INSENSITIVE, because Crockford base32 is: the encoding defines lower
 * case as equivalent on decode, and an id makes the trip through URLs, chat
 * clients that lower-case what they linkify, and agents that "tidy" text. A
 * lower-cased id used to fall out of the id space entirely and into the
 * client-NAME space, where it produced an error about there being no local
 * client of that name — for an id the user had copied correctly.
 *
 * The two address spaces are still told apart by shape, and this widens the
 * id side by exactly the strings that decode to the same 26 symbols. A local
 * client whose name is 26 characters of base32 would now be read as an id;
 * that is the safe direction, because the id path reads nothing off this
 * disk while the name path reads the peer's whole profile, auth token
 * included.
 */
const USER_ID_RE = /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/;

export function isUserId(value: string): boolean {
  return USER_ID_RE.test(value);
}

/** The one spelling the wire uses. Ids are compared as raw strings server-side
 * (they are partition keys), so a lower-cased id must be normalised BEFORE it
 * reaches a frame, never after. */
export function normalizeUserId(value: string): string {
  return value.toUpperCase();
}

/**
 * Resolve a recipient — a bare userId, or a local client name.
 *
 * The whole address space this CLI understood was directory names under
 * `$TACENDUM_HOME`. `cli send ci-bot 01ARZ3NDEKTSV4RRFFQ69G5FAV` did not fail
 * with "that's an id, not a name" — a ULID passes the client-name regex, so it
 * built `$TACENDUM_HOME/01ARZ.../profile.json`, found nothing, and reported
 * `no profile for "01ARZ..." — run: cli register 01ARZ...`, which is advice
 * that would have created a SECOND ACCOUNT named after the recipient. That is
 * not a product: an integration is handed a 26-char code out of the app and
 * has nothing local about the person it is notifying.
 *
 * The wire has always been ULID-addressed end to end (`SendFrame.to`); only
 * the command line refused to let one in.
 *
 * Note what the name path actually does, and why it is same-machine-only by
 * construction rather than by convenience: it reads the PEER'S ENTIRE PROFILE
 * — including their auth token — off this disk. The id path reads nothing.
 */
export function resolveRecipient(peer: string): string {
  if (isUserId(peer)) return normalizeUserId(peer);
  // `profilePath` rejects anything that is not a legal client name, and a
  // recipient that is neither a legal name nor an id is the same user error as
  // one that simply has no profile — so both arrive at the same advice.
  let path: string;
  try {
    path = profilePath(peer);
  } catch {
    path = '';
  }
  if (!path || !existsSync(path)) {
    // NEVER "run: tacendum register <peer>". That advice creates a second
    // LOCAL account named after the RECIPIENT, and the next send resolves the
    // name to that stub and reports success — a message delivered to a
    // freshly minted account nobody reads, with exit 0. It is the exact trap
    // this function's docstring exists to describe, and the error used to
    // recreate it; a real user followed it.
    // THE RECIPIENT IS NEVER ECHOED — not conditionally, never. `tacendum
    // send ci "$SECRET"` — one missing argument — shifts the message body into
    // this position, and this error reaches stderr and --json, i.e. CI and
    // Claude Code hook logs. This leak has now been reopened TWICE by
    // shape allowlists that tried to keep the echo: "legal client name" admits
    // an AWS access key id verbatim, and a looks-shortened branch printed any
    // quoted sentence containing "..." in full. The one value provably safe to
    // show — a client name that exists on this disk — cannot occur in this
    // branch, because nonexistence is exactly what was just established. So
    // there is nothing safe left to show, and the user has the value on their
    // own screen anyway; the diagnosis is what is wrong and what to do.
    // `looksShortened` picks the advice sentence only; it must never gate an
    // echo.
    const looksShortened = /[…]|\.\.\./.test(peer);
    const why = looksShortened
      ? `that recipient looks like a SHORTENED id — it has to be pasted in full (26 characters)`
      : `cannot address that recipient: it is not a 26-character user id, and there is ` +
        `no local client of that name`;
    throw new CliError(
      EXIT.RECIPIENT,
      `${why}. Get the full id from the recipient's my-code screen in the app ` +
        `and pass it as the recipient.`,
    );
  }
  // FACTS ONLY, for the reason `loadProfileFacts` states: the one field this
  // function wants is the userId, and refusing to address a recipient because
  // of a credential nobody here will present is a refusal about the wrong
  // thing.
  return loadProfileFacts(peer).userId;
}
