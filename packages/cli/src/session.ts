import { join } from 'node:path';
import { apiAuth, apiAuthChallenge, type TokenProvider } from './api.js';
import { bytesToB64 } from './bytes.js';
import { CliError, EXIT } from './exit.js';
import { withFileLockAsync } from './lock.js';
import { signAuthChallenge } from './messaging.js';
import { loadProfile, readProfile, saveProfile, type Profile } from './profile.js';
import type { FileStores } from './stores.js';

/**
 * The renewable credential — the item that decides whether this
 * product works at all.
 *
 * Sessions last 30 days (`SESSION_TTL_SECONDS`, packages/shared/src/dto.ts).
 * Without renewal, every integration installed today stops working on day 31,
 * and it stops working SILENTLY: the CLI is invoked by a Makefile, a cron
 * line, or a Claude Code hook, all of which discard stderr. A build pipeline
 * that has been failing to notify for a week is strictly worse than one that
 * never notified at all, because the operator believes they are covered.
 *
 * Keypair accounts make the fix nearly free. Everything needed to mint a new
 * token is already on this disk — the identity private key in `identity.json`
 * IS the account. Renewal is three calls that
 * `cmdRegister` already makes, minus the key upload: the identity key is
 * immutable server-side, the keys are already up, and re-uploading would drag
 * prekey replenishment into a code path that has nothing to do with it.
 *
 * ONE PLACE, by construction. `api.request()` holds it for every authed REST
 * route and `WsClient.connect()` for the socket, and both hold the SAME object
 * — so `this.inflight` below is a single-flight across both transports, not
 * two independent ones that would race each other into two mints.
 *
 * FOUR SERVER-IMPOSED CONSTRAINTS, each of which is a real failure if ignored:
 *
 *  1. **Every successful auth revokes every prior session for that user**
 *     (`auth-account.ts` `deleteSessionsForUser`). Two long-lived CLI
 *     processes under one client name would therefore invalidate each other
 *     forever, alternating mints until the rate limiter stopped them. Two
 *     mitigations, and they cover different halves:
 *       - IN-PROCESS: `this.inflight` below joins callers that 401 in the same
 *         tick, and `api.ts`/`wsclient.ts` compare the bearer that actually
 *         FAILED against `token()` before calling in, which covers the
 *         staggered case the lock cannot (it is cleared in `finally`).
 *       - CROSS-PROCESS: `mint()` serializes through `auth.lock` and re-reads
 *         `profile.json` UNDER the lock, adopting a token another process
 *         already wrote instead of minting its own. The file is the shared
 *         point of truth; the in-memory field is only a cache of it. The
 *         re-read used to run without the lock and be the whole mitigation,
 *         and it lost whenever the mints genuinely OVERLAPPED: N parallel
 *         `tacendum send` processes — a `make -j` fan-out on the day the
 *         fleet's sessions expire — all read the expired profile before any
 *         wrote, minted N tokens of which the server kept one, and N-1
 *         commands failed with what read as dead credentials. Worse, the mint
 *         whose profile write landed LAST could leave an already-revoked
 *         token as the shared on-disk value, so the NEXT invocation started
 *         dead too. The profile write therefore stays inside the lock: no
 *         auth can begin until the previous winner's token is on disk.
 *  2. **`userId` must be asserted unchanged.** `getOrCreateUserByIdentityKey`
 *     will happily CREATE an account for a known key whose user row is gone —
 *     which is exactly what `DELETE /v1/account` leaves behind. Silently
 *     adopting the new id would corrupt every `ProtocolAddress` in
 *     `sessions/` and `identities/` (they are keyed by userId), turning a
 *     recoverable "your account was deleted" into an unexplainable client
 *     whose every session is addressed to a stranger.
 *  3. **409 `account_conflict` is terminal** — an account mid-deletion. It is
 *     classified AUTH by `api.ts` and never retried.
 *  4. **Retry exactly once** (enforced in `api.request` and `WsClient`). A
 *     second 401 against a token minted seconds ago is a genuine refusal.
 */
export class AuthSession implements TokenProvider {
  private profile: Profile;
  private inflight: Promise<string> | null = null;
  /** How many tokens this process actually minted. Observable so a test can
   * prove renewal HAPPENED rather than that the send merely succeeded. */
  private minted = 0;

  constructor(
    readonly name: string,
    private readonly stores: FileStores,
  ) {
    this.profile = loadProfile(name);
  }

  /** The account this credential belongs to. Never changes for a live session. */
  get userId(): string {
    return this.profile.userId;
  }

  get reauthCount(): number {
    return this.minted;
  }

  token(): string {
    return this.profile.authToken;
  }

  /**
   * Single-flight renewal. The nullable promise IS the lock: concurrent
   * callers (the REST prekey fetch and the WS dial can 401 within
   * milliseconds of each other) join the one in flight instead of each
   * signing their own challenge — and since each successful auth revokes the
   * previous session, two concurrent mints would leave one of them holding a
   * token the server had already killed.
   */
  async reauth(): Promise<string> {
    if (this.inflight) return this.inflight;
    const flight = this.mint();
    this.inflight = flight;
    try {
      return await flight;
    } finally {
      // Cleared in `finally` so a FAILED renewal does not pin a rejected
      // promise as "in flight" and reject every later caller with a stale error.
      this.inflight = null;
    }
  }

  /**
   * NOT `ratchetLockPath()`. That lock's contract is "never held across
   * network I/O" — its stale threshold is tuned to local crypto, so a mint
   * parked on a slow auth round trip would look abandoned and get stolen,
   * and a send blocked behind a mint could not even advance its ratchet.
   * The mint needs the opposite contract: the two auth round trips ARE the
   * critical section, so they get their own file.
   */
  private authLockPath(): string {
    return join(this.stores.root, 'auth.lock');
  }

  /**
   * Adopt a token another process already wrote, if the file has one we have
   * not seen. Zero network calls — and the only thing that stops two
   * long-lived CLIs under one name from revoking each other in a loop.
   *
   * Constraint 2 is enforced HERE as well as on the network path: this branch
   * used to adopt the whole profile unexamined, so a `register` re-run that
   * re-minted the name as a NEW account handed this process a token for an
   * account its sessions/ and identities/ are not keyed to — the exact
   * corruption the network path's assertion exists to refuse.
   */
  private adoptFromDisk(): string | null {
    const onDisk = loadProfile(this.name);
    if (onDisk.userId !== this.profile.userId) {
      throw new CliError(
        EXIT.AUTH,
        `account gone: the profile for "${this.name}" now names a DIFFERENT ` +
          `userId (${this.profile.userId} -> ${onDisk.userId}) — this client ` +
          `name was re-registered as a new account while this process ran. Its ` +
          `sessions and pinned peer keys address the old one, so nothing was ` +
          `adopted. Re-run the command; if this repeats, re-pair the client.`,
        'account_gone',
      );
    }
    if (onDisk.authToken && onDisk.authToken !== this.profile.authToken) {
      this.profile = onDisk;
      return onDisk.authToken;
    }
    return null;
  }

  private async mint(): Promise<string> {
    // Constraint 1, the cheap half: a sibling that renewed MINUTES ago (the
    // `listen` daemon next to a hook-driven `send`). One file read, no lock.
    const already = this.adoptFromDisk();
    if (already !== null) return already;

    // Constraint 1, the half the bare re-read lost: mints that genuinely
    // overlap. Everyone queues on the per-account lock; exactly one process
    // authenticates, and it writes the profile BEFORE releasing — so every
    // loser's re-read here (the classic double-check) finds the winner's
    // token and adopts it instead of minting one that would revoke it.
    return withFileLockAsync(this.authLockPath(), async () => {
      const adopted = this.adoptFromDisk();
      if (adopted !== null) return adopted;

      // The STORE's key, not `profile.identityKey`: the profile copy is
      // recorded "for display and for diagnosis, NOT as a credential"
      // (profile.ts), and if the two ever disagree only the store's key can
      // produce a signature that verifies.
      const identityKey = bytesToB64(this.stores.identity.getPublicIdentityKey().serialize());
      const { challenge } = await apiAuthChallenge(identityKey);
      const signature = await signAuthChallenge(this.stores, challenge);
      const { userId, authToken } = await apiAuth(identityKey, challenge, signature);

      // Constraint 2. Loud and terminal, never adopted.
      if (userId !== this.profile.userId) {
        throw new CliError(
          EXIT.AUTH,
          `account gone: re-authenticating "${this.name}" returned a NEW userId ` +
            `(${this.profile.userId} -> ${userId}). The account this client was ` +
            `registered as no longer exists, so its sessions and pinned peer keys ` +
            `address nobody. Nothing was overwritten. Register a fresh client name ` +
            `and re-pair, or restore this one's account.`,
          'account_gone',
        );
      }

      // MERGE ONE FIELD INTO WHAT IS ON DISK NOW — never re-save the snapshot
      // (an earlier review). `this.profile` was read in the constructor
      // and refreshed only by `adoptFromDisk`, and `saveProfile` writes the
      // WHOLE record: `saveProfile({ ...this.profile, authToken })` therefore
      // reverted every field an external write added while this holder was
      // alive. `ownerUserId` is the one that costs something — `pair` writes it
      // WITHOUT touching the token (`main.ts`: `saveProfile({
      // ...loadProfile(name), ownerUserId: owner })`), so `adoptFromDisk` sees
      // no change, does not refresh, and the binding is silently dropped on the
      // next renewal. The server's binding is write-once and untouched, so
      // every server-side check goes on saying the pairing is fine while this
      // machine has forgotten it and the MCP surface stops offering a send tool.
      //
      // No holder spans that window today (all thirteen `new AuthSession(`
      // sites are per-command; `cmdListen` has no reconnect and exits from
      // `onClose`; `attend` builds a fresh session per reply), so this is
      // hardening, not a live bug — but "unreachable" there is a property of
      // thirteen call sites, not of this class, and `cmdPair` and `setup.ts`
      // already write profiles exactly this way. (The count is the evidence
      // that the sweep was exhaustive, so it has to be right: an earlier revision
      // recounted the earlier "twelve" and found thirteen — main.ts x3,
      // call-session.ts, crew.ts, room-commands.ts, setup.ts x2,
      // review-peer.ts, attend.ts, send.ts, hooks.ts, run.ts.)
      //
      // THE READ IS CORRECT HERE because it is inside the auth lock, taken
      // after the round trips and immediately before the write, so no mint can
      // interleave between them. `readProfile` rather than `loadProfile`: a
      // stored token an older build wrote makes `loadProfile` THROW, and
      // throwing away a token we have just minted — over the very field we are
      // about to replace — would strand the account (profile.ts,
      // `UnusableTokenError`). Its `profile` carries the account's facts with
      // the credential emptied, which is precisely the record to merge into.
      const onDisk = readProfile(this.name);
      // Constraint 2 once more, for the file as it stands NOW. `register` runs
      // under `register.lock`, not this one, so a re-registration CAN land
      // between the adoption check above and here — and merging our token into
      // a stranger's record would be the corruption constraint 2 exists to
      // refuse, done quietly. Anything but a readable profile for the SAME
      // account keeps the old behaviour: write our own record, which is what
      // this line did unconditionally before.
      const base =
        onDisk.kind === 'ok' && onDisk.profile.userId === this.profile.userId
          ? onDisk.profile
          : this.profile;
      this.profile = { ...base, authToken };
      // Inside the lock on purpose: a save that landed after the NEXT mint
      // would put a token that mint had already revoked back on disk as the
      // shared value, and every later invocation would start dead.
      saveProfile(this.profile);
      this.minted += 1;
      return authToken;
    });
  }
}
