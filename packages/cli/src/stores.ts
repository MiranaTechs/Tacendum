import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import {
  Direction,
  IdentityChange,
  IdentityKeyPair,
  IdentityKeyStore,
  KyberPreKeyRecord,
  KyberPreKeyStore,
  PreKeyRecord,
  PreKeyStore,
  PrivateKey,
  ProtocolAddress,
  PublicKey,
  SessionRecord,
  SessionStore,
  SignedPreKeyRecord,
  SignedPreKeyStore,
} from '@signalapp/libsignal-client';
import {
  FILE_MODE,
  fsyncDir,
  recordPersistenceFailure,
  takePersistenceFailure,
  writeFileAtomic,
} from './atomic-write.js';
import { clientDir } from './config.js';
import { b64ToBytes, bytesToB64 } from './bytes.js';
import { CliError, EXIT } from './exit.js';
import { readCredential } from './keychain.js';

// Re-exported so the many existing importers (messaging, msglog, inbound,
// hooks, setup, hostconfig, tests) keep one import path. New code may import
// from './atomic-write.js' directly; keychain.ts MUST (it is what breaks the
// stores -> keychain -> stores cycle the readCredential import above would
// otherwise create — see atomic-write.ts's header).
export { takePersistenceFailure, writeFileAtomic } from './atomic-write.js';

/**
 * File-backed libsignal protocol stores under `$TACENDUM_HOME/<name>/`
 *. All records are libsignal's own serialized forms —
 * this file only does storage, never cryptography.
 *
 * Layout:
 *   identity.json            identity key pair (b64) + registration id
 *   sessions/<peer>.<dev>.bin
 *   identities/<peer>.<dev>.pub   TOFU-pinned peer identity keys
 *   prekeys/<id>.bin
 *   signed-prekeys/<id>.bin
 *   kyber-prekeys/<id>.bin
 *   seen.json                processed msgIds (client-side dedupe)
 */

const DIR_MODE = { recursive: true as const, mode: 0o700 };

function addrKey(address: ProtocolAddress): string {
  return `${address.name()}.${address.deviceId()}`;
}

/**
 * THE STORE-BOUNDARY FAILURE RECORD — the stores' first-party answer to a
 * problem this repo has now been bitten by twice: libsignal wraps ANY error a store callback throws in a
 * code-Generic LibSignalErrorBase, erasing its type, errno and CliError-ness,
 * so on the far side of that boundary OUR refusal is BY TYPE indistinguishable
 * from an attacker's tampered ciphertext — and the tamper branch ACKS, which
 * deletes the server's only copy of a message that was fully retryable.
 *
 * Both previous fixes instrumented the KNOWN failing methods (first
 * `writeFileAtomic`'s throw, then the three write callbacks), and each time
 * the next store error to surface — an identity READ this time — fell through
 * the list. The list is the defect. So this records at the boundary itself:
 * every method of every store object handed to libsignal is wrapped, at
 * construction, by enumerating the instances' real prototype chains — reads,
 * writes, helpers, and any method either class GROWS later, because the
 * enumeration happens against whatever the prototype actually holds, not
 * against a hand-maintained inventory. A third kind of store error cannot
 * repeat the miss, because there is no list left to be missing from: if our
 * code threw it from inside a store callback, it crossed this wrapper.
 *
 * The rule this rests on: an error thrown from OUR side of a store callback
 * is evidence about THIS MACHINE (a locked keychain, a full disk, a lost
 * file, corrupt local state), never about the peer's bytes — so it must never
 * be allowed to take the branch that treats the peer's bytes as poison.
 * Classification of a failed decrypt (inbound.ts `classifyDecryptFailure`)
 * asks this record, via the probe, AFTER libsignal's wrapper has erased
 * everything else.
 *
 * Residual, stated honestly: a store ABSENCE whose id came off the wire (a
 * crafted prekey id raising `no prekey N`) is our-side by provenance and now
 * classifies as local — such a frame stays queued and redelivers until the
 * server's 30-day TTL instead of being purged. That costs one warning line
 * per connect; the branch it forecloses cost the only copy of real mail.
 *
 * The slot is per-FileStores and armed by the consumer before each decrypt
 * (see `probeStorePersistence` in inbound.ts); decrypts are serialized under
 * ratchet.lock, which is what makes a single slot sound.
 */
function recordThrowsAcrossStoreBoundary(store: object, slot: { failure: unknown }): void {
  const wrapped = new Set<string>();
  for (
    let proto: object | null = store;
    proto !== null && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto) as object | null
  ) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key === 'constructor' || wrapped.has(key)) continue;
      wrapped.add(key);
      const desc = Object.getOwnPropertyDescriptor(proto, key);
      if (desc === undefined || typeof desc.value !== 'function') continue;
      const fn = desc.value as (...args: unknown[]) => unknown;
      Object.defineProperty(store, key, {
        value: function (this: unknown, ...args: unknown[]): unknown {
          // Record-and-rethrow UNTOUCHED, sync and async alike: nothing
          // downstream may be able to tell the wrapper is there, and the
          // methods here are a mix of both colors — an async wrapper around a
          // sync method would silently change its callers' contract.
          try {
            const out = fn.apply(this, args);
            if (out instanceof Promise) {
              return out.catch((err: unknown) => {
                slot.failure = err ?? new Error('store operation failed');
                throw err;
              });
            }
            return out;
          } catch (err) {
            slot.failure = err ?? new Error('store operation failed');
            throw err;
          }
        },
        writable: true,
        configurable: true,
      });
    }
  }
}

/** Plain equality of public-key bytes — comparison, not cryptography. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export class FileStores {
  readonly root: string;
  readonly sessions: FileSessionStore;
  readonly identity: FileIdentityKeyStore;
  readonly prekeys: FilePreKeyStore;
  readonly signedPrekeys: FileSignedPreKeyStore;
  readonly kyberPrekeys: FileKyberPreKeyStore;

  /**
   * Serialize the ratchet across PROCESSES.
   *
   * `listen` in one terminal and a hook-driven `send` in another share this
   * directory by design, and both do a read-modify-write of the same session
   * file. Without this, one process's chain advance silently overwrites the
   * other's: messages that never decrypt, or a session forked so badly both
   * ends must reset. The NSE hit exactly this race and got a lock; the CLI
   * had none.
   *
   * Held around the libsignal call and its store writes only — never across
   * network I/O, so it is measured in milliseconds and the stale threshold
   * can stay well above any honest hold.
   */
  ratchetLockPath(): string {
    return join(this.root, 'ratchet.lock');
  }

  /** See `takePersistenceFailure` in atomic-write.ts: same slot, reachable
   * from the `stores` handle the inbound path already holds. */
  takePersistenceFailure(): Error | null {
    return takePersistenceFailure();
  }

  /** The store-boundary failure slot — see `recordThrowsAcrossStoreBoundary`. */
  private readonly boundaryFailure: { failure: unknown } = { failure: undefined };

  /** Forget any recorded boundary failure. The consumer calls this before a
   * decrypt so stale evidence from an earlier operation cannot reclassify a
   * genuinely tampered frame as local. */
  armStoreBoundary(): void {
    this.boundaryFailure.failure = undefined;
  }

  /** Did OUR store code throw — read, write, or refusal — since the last
   * `armStoreBoundary()`? True means the last decrypt failure is evidence
   * about this machine, not about the peer's bytes. */
  storeBoundaryFailed(): boolean {
    return this.boundaryFailure.failure !== undefined;
  }

  /** The recorded throw ITSELF — the error as OUR code raised it, before
   * libsignal's wrapper erased its type and errno. Surrendered so the
   * local-failure note can describe WHAT failed (`describeLocalFailure`,
   * inbound.ts) without printing the wrapper's message: for an fs error that
   * message embeds the failing file path, and every path under this store
   * embeds the account name — a caller-supplied value.
   * `undefined` iff `storeBoundaryFailed()` is false. */
  storeBoundaryFailure(): unknown {
    return this.boundaryFailure.failure;
  }

  constructor(name: string) {
    this.root = clientDir(name);
    mkdirSync(this.root, DIR_MODE);
    this.sessions = new FileSessionStore(this.root);
    this.identity = new FileIdentityKeyStore(this.root, name);
    this.prekeys = new FilePreKeyStore(this.root);
    this.signedPrekeys = new FileSignedPreKeyStore(this.root);
    this.kyberPrekeys = new FileKyberPreKeyStore(this.root);
    // Every store object libsignal is ever handed (decryptEnvelope,
    // signalEncrypt, processPreKeyBundle all draw from this set). Instrumented
    // HERE, at construction, so no consumer has to remember to — the previous
    // consumer-side probe wrapped three write methods and the identity READS
    // fell through it.
    for (const sub of [
      this.sessions,
      this.identity,
      this.prekeys,
      this.signedPrekeys,
      this.kyberPrekeys,
    ]) {
      recordThrowsAcrossStoreBoundary(sub, this.boundaryFailure);
    }
  }

  // --- msgId dedupe ---

  private seenPath(): string {
    return join(this.root, 'seen.json');
  }

  hasSeen(msgId: string): boolean {
    return this.loadSeen().includes(msgId);
  }

  markSeen(msgId: string): void {
    const seen = this.loadSeen();
    seen.push(msgId);
    // Bounded: the server queue TTL is 30 days; 5000 ids is ample headroom.
    writeFileAtomic(this.seenPath(), JSON.stringify(seen.slice(-5000)), FILE_MODE);
  }

  private loadSeen(): string[] {
    if (!existsSync(this.seenPath())) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.seenPath(), 'utf8')) as unknown;
      return Array.isArray(parsed) ? (parsed as string[]) : [];
    } catch {
      // Corruption reads as "nothing seen yet", exactly as the sibling
      // loaders below already do. Letting the
      // parse throw wedged the ENTIRE receive path: hasSeen runs on every
      // inbound frame, so one truncated file meant nothing was decrypted,
      // acked or shown again and the queue drained to its 30-day TTL. The
      // cost of this fallback is re-displaying an already-seen message,
      // which the ratchet refuses to decrypt twice in any case — strictly
      // better than silence.
      return [];
    }
  }

  // --- pending identity changes (what `tacendum trust` is allowed to accept) ---
  //
  // libsignal raises an identity change in two places — an inbound decrypt and
  // an outbound session establishment — and both are in a process that then
  // exits. `tacendum trust` runs later, usually in a different process, and it
  // is DESTRUCTIVE: it un-pins the peer's key and drops the session. Without a
  // record of what was actually refused, `trust` has no way to tell an accepted
  // change from a typo'd peer name, so it did the destructive thing for both
  // and reported success either way. This file is that record.
  //
  // Peer ids only — public, server-assigned, and already all over the store
  // directory names. Nothing secret goes in here.

  private identityChangesPath(): string {
    return join(this.root, 'identity-changes.json');
  }

  private loadIdentityChanges(): string[] {
    if (!existsSync(this.identityChangesPath())) return [];
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.identityChangesPath(), 'utf8'));
      return Array.isArray(parsed) ? parsed.filter(v => typeof v === 'string') : [];
    } catch {
      // A corrupt marker file must not make `trust` impossible to run; the
      // worst case of treating it as empty is one extra warning.
      return [];
    }
  }

  hasIdentityChange(peerUserId: string): boolean {
    return this.loadIdentityChanges().includes(peerUserId);
  }

  /** Every peer with a change pending — `contacts` reports these as CHANGED,
   * because a list that says "pinned" about a peer the client is actively
   * refusing to decrypt would be telling the operator the opposite of the
   * one thing the warning exists to say. */
  listIdentityChanges(): string[] {
    return this.loadIdentityChanges();
  }

  markIdentityChange(peerUserId: string): void {
    const pending = this.loadIdentityChanges();
    if (pending.includes(peerUserId)) return;
    pending.push(peerUserId);
    writeFileAtomic(this.identityChangesPath(), JSON.stringify(pending.slice(-256)), FILE_MODE);
  }

  clearIdentityChange(peerUserId: string): void {
    const pending = this.loadIdentityChanges().filter(id => id !== peerUserId);
    writeFileAtomic(this.identityChangesPath(), JSON.stringify(pending), FILE_MODE);
  }

  // --- peer display names ---
  //
  // "01ARZ…" is the only address the wire has, and nobody should have to send
  // to one on faith. The one place a peer TELLS us their name is the `profile`
  // envelope, which arrives inside the ratchet — so it is authenticated by the
  // session that decrypted it, not by the server. Recorded here when
  // `attachInbound` sees one, read back by `contacts`.
  //
  // The name is peer-chosen text bound for a terminal, so it is stored as
  // `render.ts` already sanitized and bounded it — and sanitized AGAIN at
  // display, because a file is an input too.

  private peerNamesPath(): string {
    return join(this.root, 'peer-names.json');
  }

  loadPeerNames(): Record<string, string> {
    if (!existsSync(this.peerNamesPath())) return {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.peerNamesPath(), 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const out: Record<string, string> = {};
      for (const [peer, name] of Object.entries(parsed)) {
        if (typeof name === 'string') out[peer] = name;
      }
      return out;
    } catch {
      // Same policy as the identity-change marker: a corrupt side file costs
      // a nicety (names), never a capability (the contact list itself).
      return {};
    }
  }

  setPeerName(peerUserId: string, displayName: string): void {
    const names = this.loadPeerNames();
    if (names[peerUserId] === displayName) return;
    names[peerUserId] = displayName;
    writeFileAtomic(this.peerNamesPath(), JSON.stringify(names), FILE_MODE);
  }

  // --- consent grants, the CLIENT's own memory (the consent remediation) ---
  //
  // The server refuses consent enumeration to everyone, the edge's own
  // writer included, and the CLI must not fake a server read. But a
  // client remembering ITS OWN ACTS is the machine_peers pattern, stated in
  // the consent route's header itself: "a client that wants to render its
  // own consents keeps its own record of the answers it received". Without
  // it a human has no way to find a stale edge to revoke — the
  // undiscoverable-slots problem — and the only remedy for a full cap is
  // ULIDs remembered by hand. So `consent grant` records the id it granted,
  // `revoke` removes it, and `consent list` reads the record back AS the
  // local memory it is (its copy says so). LOCAL ONLY, best-effort, and
  // honest about both: a grant made from another machine is not here, a
  // 204 the server quietly dropped over-cap is here anyway — the record is
  // what this client ASKED, which is exactly what revoke needs.

  private consentGrantsPath(): string {
    return join(this.root, 'consent-grants.json');
  }

  /** agentId → epoch ms of this client's own grant. Corrupt file costs the
   * nicety (the local list), never the capability (grant/revoke still work
   * blind — the server is the authority; peer-names' policy). */
  loadConsentGrants(): Record<string, number> {
    if (!existsSync(this.consentGrantsPath())) return {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.consentGrantsPath(), 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const out: Record<string, number> = {};
      for (const [agent, at] of Object.entries(parsed)) {
        if (typeof at === 'number' && Number.isFinite(at)) out[agent] = at;
      }
      return out;
    } catch {
      return {};
    }
  }

  recordConsentGrant(agentId: string, grantedAtMs: number): void {
    const grants = this.loadConsentGrants();
    // First grant wins the date: a re-grant is idempotent on the server
    // ('already') and must not re-date the client's memory of when it chose.
    if (grants[agentId] !== undefined) return;
    grants[agentId] = grantedAtMs;
    writeFileAtomic(this.consentGrantsPath(), JSON.stringify(grants), FILE_MODE);
  }

  removeConsentGrant(agentId: string): void {
    const grants = this.loadConsentGrants();
    if (grants[agentId] === undefined) return;
    delete grants[agentId];
    writeFileAtomic(this.consentGrantsPath(), JSON.stringify(grants), FILE_MODE);
  }

  // --- machine peers, the CLIENT's own memory ---
  //
  // The app's `machine_peers` pattern, ported: a 204 on `crew adopt` is the
  // server telling THIS owner, about one id, "a machine you paired" —
  // memory of a disclosure already made to the one party entitled to it,
  // never enumeration and never a guess (machine.ts holds the rule). The
  // record is what lets the owner's roster writes carry
  // `class: 'integration'` (the consent-bootstrap fix), so a stranger's
  // device can offer the choice before the agent ever speaks. Append-only
  // like the app's table: a class is birth-permanent, so nothing removes a
  // row — the CLI has no revoke surface anyway (revoke is the phone's).

  private machinePeersPath(): string {
    return join(this.root, 'machine-peers.json');
  }

  /** peerId → epoch ms this client first learned it. Corrupt file costs the
   * nicety (the class on future roster writes), never the capability —
   * absent is the safe default everywhere the class is read. */
  loadMachinePeers(): Record<string, number> {
    if (!existsSync(this.machinePeersPath())) return {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.machinePeersPath(), 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const out: Record<string, number> = {};
      for (const [peer, at] of Object.entries(parsed)) {
        if (typeof at === 'number' && Number.isFinite(at)) out[peer] = at;
      }
      return out;
    } catch {
      return {};
    }
  }

  recordMachinePeer(peerId: string, learnedAtMs: number): void {
    const peers = this.loadMachinePeers();
    // First answer wins the date — a re-adopt answers the same (204) and
    // must not re-date this client's memory of when it learned.
    if (peers[peerId] !== undefined) return;
    peers[peerId] = learnedAtMs;
    writeFileAtomic(this.machinePeersPath(), JSON.stringify(peers), FILE_MODE);
  }
}

// --- identity ---

interface IdentityFile {
  identityKeyPair: string; // b64, IdentityKeyPair.serialize()
  registrationId: number;
}

export class FileIdentityKeyStore extends IdentityKeyStore {
  private readonly identityPath: string;
  private readonly peersDir: string;

  /** `name` is the account name — the keychain item coordinate that lets
   * `exists`/`load` consult `readCredential` (keychain.ts), which is where
   * "where does THIS account's credential live" is decided. */
  constructor(root: string, private readonly name: string) {
    super();
    this.identityPath = join(root, 'identity.json');
    this.peersDir = join(root, 'identities');
    mkdirSync(this.peersDir, DIR_MODE);
  }

  /**
   * True once this client has an identity keypair — on disk, or in the OS
   * keychain (`tacendum credential --migrate`, keychain.ts).
   *
   * Load-bearing since keypair-only accounts: the
   * identity key IS the account, and it is immutable server-side. A
   * re-run that quietly generated a second keypair would mint a SECOND account
   * and orphan the first — same `name`, same store directory, different
   * `userId`, and every peer still pinning the old key. `cmdRegister` asks this
   * before it generates anything.
   *
   * The file check runs first because it is free and settles the common case;
   * only a fileless store consults the credential chain. `readCredential`
   * deliberately THROWS (EXIT.AUTH / EXIT.ERROR) instead of answering null
   * when a credential is recorded-or-profile-evidenced but unreadable — and
   * that refusal must propagate out of here untouched: catching it into
   * `false` is precisely the answer that lets `cmdRegister`/`setup` silently
   * replace a live account, which is worse than any failed command.
   */
  exists(): boolean {
    if (existsSync(this.identityPath)) return true;
    return this.readCredentialGuarded() !== null;
  }

  /**
   * `readCredential`, with what may ESCAPE this store pinned down. Errors thrown from here travel far: a
   * decrypt wraps them in libsignal's LibSignalErrorBase, whose message is
   * printed in decrypt diagnostics, and a direct caller (signAuthChallenge,
   * safety numbers) lets them reach top-level stderr and `--json`.
   *
   * What may travel, and nothing else:
   *  - a CliError minted by keychain.ts — sanitized by construction over
   *    there (fixed prose plus a classified stderr string, never the value,
   *    never the account name), and its AUTH/ERROR split is the refusal
   *    contract `exists()`/`load()` exist to propagate;
   *  - a CliError minted HERE, carrying fixed prose and at most an errno
   *    code. The raw fs error it replaces embeds the full identity.json
   *    path — which contains the account name. The errno
   *    code is an OS-defined vocabulary word, shape-checked below so an
   *    exotic error object cannot smuggle arbitrary text through the slot.
   */
  private readCredentialGuarded(): string | null {
    try {
      return readCredential(this.name);
    } catch (err) {
      if (err instanceof CliError) throw err;
      const code = (err as NodeJS.ErrnoException).code;
      const errno = typeof code === 'string' && /^E[A-Z0-9]{1,16}$/.test(code) ? code : 'unreadable';
      throw new CliError(
        EXIT.ERROR,
        `the account credential file could not be read (${errno}) — nothing is ` +
          `wrong with the credential itself; retry once the file is readable`,
      );
    }
  }

  /**
   * Parse the credential blob so that NO BLOB BYTE can ever reach an
   * exception message. A bare `JSON.parse(blob)` here let
   * Node's SyntaxError quote a fragment of its input — a fragment of the
   * CREDENTIAL — and the gate watched that fragment travel through
   * libsignal's wrapper into decrypt diagnostics and top-level `--json`. The
   * caught error is DISCARDED, never rethrown and never interpolated; the
   * replacement carries fixed prose only. Shape violations take the same
   * road, because "expected string, got <value>" would be the same leak
   * through a different door.
   */
  private parseCredential(blob: string): IdentityFile {
    const refuse = (): CliError =>
      new CliError(
        EXIT.AUTH,
        'the stored credential is not in the format this CLI writes — restore ' +
          'identity.json from backup; the key IS the account and cannot be re-minted',
      );
    let parsed: unknown;
    try {
      parsed = JSON.parse(blob);
    } catch {
      throw refuse();
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw refuse();
    const record = parsed as { identityKeyPair?: unknown; registrationId?: unknown };
    /*
     * AN INTEGER, not merely a number — and the check is here, in the PRODUCT,
     * rather than in the conformance corpus that noticed the gap.
     *
     * `typeof === 'number'` accepted `registrationId: 42.5`, and both this
     * store and doctor's mirror agreed it was fine. Nothing downstream does:
     * `UploadKeysRequest`/`PrekeyBundle` in packages/shared declare
     * `z.number().int().nonnegative()`, and installed libsignal (0.98.0)
     * refuses the value where it crosses into Rust — `PreKeyBundle.new` raises
     * `RangeError: cannot convert 42.5 to u32`, measured. So a credential this
     * loader called good was one the first send would fail on, in a command
     * with no idea why. A predicate that admits a value the very next layer
     * refuses is the same false green an earlier revision fixed one level up.
     *
     * NOTHING ON DISK IS REFUSED BY THE TIGHTENING, and that is checkable
     * rather than hopeful: this file is written in exactly one place —
     * `initialize`, below — and its only caller is `generateAndStoreKeys`
     * (messaging.ts), which draws the id with `randomInt(1, 16384)` from
     * node:crypto. That returns an integer, always has, and there is no other
     * writer. A non-integer id in identity.json can only have come from a hand
     * edit or a corrupted file, which is precisely what this function exists
     * to refuse.
     *
     * NO RANGE CHECK, deliberately. `registrationId: 0` is accepted here and
     * by libsignal and by the shared schema, even though the writer never
     * emits it (its range starts at 1) — a loader may accept more than the
     * writer produces, and narrowing to the writer's range would be a
     * divergence the corpus agrees with rather than catches: both sides
     * tightened the same way agree perfectly and are both wrong.
     */
    if (
      typeof record.identityKeyPair !== 'string' ||
      typeof record.registrationId !== 'number' ||
      !Number.isInteger(record.registrationId)
    ) {
      throw refuse();
    }
    return { identityKeyPair: record.identityKeyPair, registrationId: record.registrationId };
  }

  /** One-time initialization at registration. Refuses to overwrite.
   *
   * 'durable-verified', not 'durable': this is the one write where an
   * unverifiable commit must not report success and where the freshly
   * `mkdir -p`'d directory chain must survive a power cut too — the private
   * key it lands is the only thing that can ever prove the account, and the
   * server pins the public half immutably (see `writeFileAtomic`). */
  initialize(keyPair: IdentityKeyPair, registrationId: number): void {
    // The guard is `exists()`, not a bare file check, and for exists()'s own
    // reason: a credential living only in the OS keychain is still THE
    // account, and writing a fresh identity.json beside it would fork the two
    // copies keychain.ts promises can never disagree. exists()'s refusal on
    // an unreachable keychain propagates too — the one write that mints an
    // account must not run on an unanswered question.
    if (this.exists()) {
      throw new Error('identity already exists; refusing to overwrite');
    }
    const record: IdentityFile = {
      identityKeyPair: bytesToB64(keyPair.serialize()),
      registrationId,
    };
    try {
      writeFileAtomic(this.identityPath, JSON.stringify(record), FILE_MODE, 'durable-verified');
    } catch (err) {
      // A REFUSED commit must not survive as a file: `exists()` gates
      // re-registration, so a leftover identity.json would make the retry
      // silently adopt the very commit this attempt could not verify —
      // reopening the reported-success-without-verification hole one run
      // later. Removing it is safe here and only here: the public half has
      // not left the process (the upload runs strictly after
      // `loadOrGenerateKeys` returns), so no server state references it yet.
      try {
        if (existsSync(this.identityPath)) unlinkSync(this.identityPath);
      } catch {
        // The original failure is the story; a failed cleanup must not mask it.
      }
      throw err;
    }
  }

  /**
   * The identity keypair, from wherever the credential actually lives.
   *
   * `readCredential` owns the resolution order (keychain.ts): a recorded
   * keychain backend is read first, the retained 0600 file answers when it is
   * present (which keeps a file-era account on the exact byte path it always
   * had — no marker means one existsSync and one readFileSync, as before),
   * and a lost marker is probed past before anything answers null. This is
   * the wiring that makes `--migrate` a migration rather than a mirror: every
   * operational identity read — getIdentityKey, getLocalRegistrationId,
   * safety numbers — goes through this one function, so none of them requires
   * identity.json once the keychain holds the credential.
   */
  private load(): IdentityFile {
    const blob = this.readCredentialGuarded();
    if (blob === null) {
      throw new Error('no identity — register this client first');
    }
    return this.parseCredential(blob);
  }

  override async getIdentityKey(): Promise<PrivateKey> {
    return IdentityKeyPair.deserialize(b64ToBytes(this.load().identityKeyPair)).privateKey;
  }

  /** Our own identity public key (for safety-number computation). */
  getPublicIdentityKey(): PublicKey {
    return IdentityKeyPair.deserialize(b64ToBytes(this.load().identityKeyPair)).publicKey;
  }

  /** Drop a peer's pinned identity so the next contact re-pins (TOFU). Used by
   * the explicit "accept a changed safety number" flow. */
  clearPeer(name: ProtocolAddress): void {
    const path = this.peerPath(name);
    if (existsSync(path)) unlinkSync(path);
  }

  /**
   * Every peer userId with a pinned identity key on disk — the TOFU roster
   * `contacts` starts from. Read off the directory because the directory IS
   * the store: a separate index would be one more thing that can disagree
   * with it. File names are `<userId>.<deviceId>.pub`; the device id is
   * always 1 in this milestone, and duplicates would only appear if that
   * ever changes, so they are collapsed rather than trusted not to exist.
   */
  pinnedPeers(): string[] {
    const ids = new Set<string>();
    for (const file of readdirSync(this.peersDir)) {
      if (!file.endsWith('.pub')) continue;
      const dot = file.indexOf('.');
      if (dot > 0) ids.add(file.slice(0, dot));
    }
    return [...ids];
  }

  override async getLocalRegistrationId(): Promise<number> {
    return this.load().registrationId;
  }

  private peerPath(name: ProtocolAddress): string {
    return join(this.peersDir, `${addrKey(name)}.pub`);
  }

  override async saveIdentity(
    name: ProtocolAddress,
    key: PublicKey,
  ): Promise<IdentityChange> {
    const existing = await this.getIdentity(name);
    const changed = existing !== null && !bytesEqual(existing.serialize(), key.serialize());
    writeFileAtomic(this.peerPath(name), bytesToB64(key.serialize()), FILE_MODE);
    return changed ? IdentityChange.ReplacedExisting : IdentityChange.NewOrUnchanged;
  }

  /** Trust-on-first-use; the safety-number verification UX builds on top. */
  override async isTrustedIdentity(
    name: ProtocolAddress,
    key: PublicKey,
    _direction: Direction,
  ): Promise<boolean> {
    const existing = await this.getIdentity(name);
    if (!existing) return true;
    return bytesEqual(existing.serialize(), key.serialize());
  }

  override async getIdentity(name: ProtocolAddress): Promise<PublicKey | null> {
    const path = this.peerPath(name);
    if (!existsSync(path)) return null;
    return PublicKey.deserialize(b64ToBytes(readFileSync(path, 'utf8')));
  }
}

// --- sessions ---

export class FileSessionStore extends SessionStore {
  private readonly dir: string;

  constructor(root: string) {
    super();
    this.dir = join(root, 'sessions');
    mkdirSync(this.dir, DIR_MODE);
  }

  private path(name: ProtocolAddress): string {
    return join(this.dir, `${addrKey(name)}.bin`);
  }

  override async saveSession(name: ProtocolAddress, record: SessionRecord): Promise<void> {
    writeFileAtomic(this.path(name), record.serialize(), FILE_MODE);
  }

  override async getSession(name: ProtocolAddress): Promise<SessionRecord | null> {
    const path = this.path(name);
    if (!existsSync(path)) return null;
    return SessionRecord.deserialize(new Uint8Array(readFileSync(path)));
  }

  override async getExistingSessions(addresses: ProtocolAddress[]): Promise<SessionRecord[]> {
    const out: SessionRecord[] = [];
    for (const addr of addresses) {
      const session = await this.getSession(addr);
      if (session) out.push(session);
    }
    return out;
  }

  /** Forget a peer's session so the next send re-establishes one (used with a
   * pinned-identity reset when accepting a changed safety number). */
  clear(name: ProtocolAddress): void {
    const path = this.path(name);
    if (existsSync(path)) unlinkSync(path);
  }
}

// --- one-time prekeys ---

export class FilePreKeyStore extends PreKeyStore {
  private readonly dir: string;

  constructor(root: string) {
    super();
    this.dir = join(root, 'prekeys');
    mkdirSync(this.dir, DIR_MODE);
  }

  private path(id: number): string {
    return join(this.dir, `${id}.bin`);
  }

  /**
   * The ONE crash-consistent write in this file (see `writeFileAtomic`) —
   * and it is only tolerable because `persistBatch` closes the window it
   * opens BEFORE anything is advertised.
   *
   * Registration mints 100 of these back to back; per-write F_FULLFSYNC is a
   * multi-second synchronous stall (the previous round's measurement) for no
   * ordering benefit. But the earlier version of this argument — "a crash in
   * the writeback window only loses messages until the next PUT replaces the
   * pool" — priced the loss wrong: a power cut that keeps the
   * durable high-water mark and the server upload while dropping these
   * non-fsynced private files turns every fetched bundle into a message that
   * decrypt-fails and is ACKed away as poison. Durability is therefore
   * required not per-write but BEFORE THE PUBLIC HALVES ARE ADVERTISED:
   * rotation writes the batch this fast way, then `persistBatch` fsyncs the
   * files concurrently and the directory once, and only then does the upload
   * payload leave `loadOrGenerateKeys`. The high-water mark (`advanceTo`)
   * stays durable below regardless: ITS rollback reissues consumed ids,
   * which is the brick.
   */
  override async savePreKey(id: number, record: PreKeyRecord): Promise<void> {
    writeFileAtomic(this.path(id), record.serialize(), FILE_MODE, 'crash-consistent');
  }

  /**
   * Make a freshly minted batch durable — MUST complete before the batch's
   * public halves are uploaded (`PUT /v1/keys` is what turns "lost file"
   * into "lost message": once the server advertises an id, its private half
   * has to survive a power cut).
   *
   * Concurrent on purpose, and async on purpose: measured 2026-07-29 on this
   * repo's target (APFS, node 22), 100 serial fsyncSync calls cost ~430ms of
   * BLOCKED event loop — the shape that starved vitest's worker RPC last
   * round — while 100 threadpool fsyncs cost ~210ms wall with the loop free.
   * (The F_BARRIERFSYNC-per-file + one-drain pattern measured no better:
   * ~212ms.) Chunked so at most 25 fds are open at once, well under the
   * default soft descriptor limit. The single directory fsync at the end
   * persists the batch's rename entries — `savePreKey`'s shortcut skipped
   * those too — and is lenient like every non-identity write. A file that
   * cannot be fsynced (missing included) throws: better no registration than
   * an advertised key that is not on disk.
   */
  async persistBatch(ids: number[]): Promise<void> {
    const CONCURRENT = 25;
    for (let i = 0; i < ids.length; i += CONCURRENT) {
      await Promise.all(
        ids.slice(i, i + CONCURRENT).map(async (id) => {
          const handle = await open(this.path(id), 'r');
          try {
            await handle.sync();
          } finally {
            await handle.close();
          }
        }),
      );
    }
    fsyncDir(this.dir);
  }

  override async getPreKey(id: number): Promise<PreKeyRecord> {
    if (!existsSync(this.path(id))) throw new Error(`no prekey ${id}`);
    return PreKeyRecord.deserialize(new Uint8Array(readFileSync(this.path(id))));
  }

  override async removePreKey(id: number): Promise<void> {
    // Recorded like `writeFileAtomic`'s failures: libsignal calls this inside
    // a prekey decrypt, wraps a throw in LibSignalErrorBase, and without the
    // record an EIO here reads as tamper downstream (see
    // `takePersistenceFailure`).
    try {
      if (existsSync(this.path(id))) unlinkSync(this.path(id));
    } catch (err) {
      recordPersistenceFailure(err);
      throw err;
    }
  }

  count(): number {
    return readdirSync(this.dir).filter((f) => f.endsWith('.bin')).length;
  }

  /**
   * Ids of the one-time prekeys we still hold private halves for, ascending.
   *
   * Used when re-authenticating an existing identity to rebuild the upload
   * payload from disk. It must read the directory rather than assume 1..N:
   * libsignal deletes a prekey (`removePreKey`) the moment it is used to
   * decrypt, so re-advertising a fixed range would publish prekeys we can no
   * longer answer — a peer would build a session we could never open.
   */
  ids(): number[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.bin'))
      .map((f) => Number(f.slice(0, -'.bin'.length)))
      .filter((id) => Number.isInteger(id))
      .sort((a, b) => a - b);
  }

  /** Clearance jumped over when adopting the high-water mark on an account
   * that predates it — comfortably past any id the old fixed 1..100 scheme
   * could have issued, so adoption can never collide with a consumed id. */
  private static readonly LEGACY_GAP = 1000;

  private highWaterPath(): string {
    return join(this.dir, 'next-id.json');
  }

  /**
   * The next one-time prekey id that has NEVER been issued for this account.
   *
   * A high-water mark, persisted separately from the key files, because the
   * files are not a record of what has been issued — libsignal DELETES a
   * one-time prekey the moment it is used, so the highest id on disk walks
   * backwards over time. Allocating from `max(ids) + 1` therefore reissues an
   * id whose old private half was consumed and deleted: a peer holding a
   * bundle with the old key sends against that id, and the local store now
   * answers with a DIFFERENT key, so the message never opens.
   *
   * Monotonic by construction: it only ever moves forward, and a missing or
   * corrupt file falls back to one past the highest id still on disk, which is
   * the safest thing that can be inferred without it.
   */
  nextId(): number {
    const onDisk = this.ids();
    // Iterated, NOT `Math.max(...ids)`: the spread makes every surviving id a
    // function argument, and a verifier bisected that to a RangeError at
    // ~109,851 of them. Nothing prunes this directory any more (pruning on
    // local evidence deleted keys the server was still advertising — see
    // `rotateOneTimePrekeys`), so iteration is the only thing standing
    // between an old, much-rotated account and that RangeError bricking it.
    let highest = 0;
    for (const id of onDisk) if (id > highest) highest = id;
    const floor = highest + 1;
    try {
      const raw = JSON.parse(readFileSync(this.highWaterPath(), 'utf8')) as unknown;
      const stored = typeof raw === 'number' ? raw : 0;
      return Math.max(stored, floor);
    } catch {
      // NO MARK ON DISK. Either this is a brand-new store (nothing has ever
      // been issued, and `floor` is 1 — correct), or it is an account that
      // predates the mark, where `floor` is a GUESS: if its highest issued
      // prekey was already consumed and deleted, the directory no longer
      // remembers it and this would reissue that id under a new key. Every
      // account created before the mark existed is in that second case, so
      // the guess cannot be the default. Jump clear of anything the old
      // 1..COUNT scheme could have issued instead — ids are cheap, a
      // reissued one costs a message that can never be decrypted.
      if (onDisk.length === 0) return floor;
      return floor + FilePreKeyStore.LEGACY_GAP;
    }
  }

  /** Record that ids below `next` have been issued. Never moves backwards.
   *
   * Reads the STORED value directly rather than going through `nextId()`:
   * that helper adds the legacy clearance when no mark exists, and a first
   * registration writes its batch before its mark — so routing through it made
   * a brand-new account adopt the legacy gap it was never supposed to need. */
  advanceTo(next: number): void {
    let stored = 0;
    try {
      const raw = JSON.parse(readFileSync(this.highWaterPath(), 'utf8')) as unknown;
      if (typeof raw === 'number') stored = raw;
    } catch {
      stored = 0;
    }
    // Deliberately DURABLE (the default): this is one write per batch, and a
    // rolled-back mark is how a consumed id gets reissued — the batch's crash-consistent shortcut in `savePreKey` leans on
    // this write not taking the same shortcut.
    writeFileAtomic(this.highWaterPath(), JSON.stringify(Math.max(stored, next)), FILE_MODE);
  }
}

// --- signed prekeys ---

export class FileSignedPreKeyStore extends SignedPreKeyStore {
  private readonly dir: string;

  constructor(root: string) {
    super();
    this.dir = join(root, 'signed-prekeys');
    mkdirSync(this.dir, DIR_MODE);
  }

  private path(id: number): string {
    return join(this.dir, `${id}.bin`);
  }

  override async saveSignedPreKey(id: number, record: SignedPreKeyRecord): Promise<void> {
    writeFileAtomic(this.path(id), record.serialize(), FILE_MODE);
  }

  override async getSignedPreKey(id: number): Promise<SignedPreKeyRecord> {
    if (!existsSync(this.path(id))) throw new Error(`no signed prekey ${id}`);
    return SignedPreKeyRecord.deserialize(new Uint8Array(readFileSync(this.path(id))));
  }
}

// --- kyber prekeys ---

export class FileKyberPreKeyStore extends KyberPreKeyStore {
  private readonly dir: string;

  constructor(root: string) {
    super();
    this.dir = join(root, 'kyber-prekeys');
    mkdirSync(this.dir, DIR_MODE);
  }

  private path(id: number): string {
    return join(this.dir, `${id}.bin`);
  }

  override async saveKyberPreKey(id: number, record: KyberPreKeyRecord): Promise<void> {
    writeFileAtomic(this.path(id), record.serialize(), FILE_MODE);
  }

  override async getKyberPreKey(id: number): Promise<KyberPreKeyRecord> {
    if (!existsSync(this.path(id))) throw new Error(`no kyber prekey ${id}`);
    return KyberPreKeyRecord.deserialize(new Uint8Array(readFileSync(this.path(id))));
  }

  /** Our single kyber prekey is last-resort (reusable) — never deleted. */
  override async markKyberPreKeyUsed(
    _kyberPreKeyId: number,
    _signedPreKeyId: number,
    _baseKey: PublicKey,
  ): Promise<void> {
    // no-op by design
  }
}
