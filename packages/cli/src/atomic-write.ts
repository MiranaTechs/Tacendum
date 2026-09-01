import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

/**
 * Atomic-and-durable file writes, extracted from stores.ts so that
 * keychain.ts can use them without importing the stores module — stores.ts
 * now imports `readCredential` FROM keychain.ts (the keychain wiring for
 * identity reads), and the previous arrangement (keychain.ts importing
 * `writeFileAtomic` from stores.ts) would have made that a module cycle. ESM
 * tolerates a function-level cycle today, but "tolerates" is a property of
 * the current import order, not of the code; this module has no imports
 * beyond node builtins, so the cycle cannot exist.
 *
 * Everything here is storage discipline, never cryptography.
 */

/** The 0600 mode every key-material and state file is written with. */
export const FILE_MODE = { mode: 0o600 };

/**
 * The last store-write failure, kept OUTSIDE the exception object because the
 * exception does not survive: a store callback that throws inside
 * signalDecrypt comes back wrapped in LibSignalErrorBase, so the inbound
 * path's `err instanceof CliError` sees false and its tamper branch marks the
 * frame seen and ACKs away the server's only copy — for a VALID message that
 * failed only because OUR disk did (EIO/ENOSPC on the fsync in
 * `writeFileAtomic`). Recorded at the choke points every decrypt-path
 * mutation goes through (`writeFileAtomic`, `removePreKey`'s unlink), read
 * back by the caller AFTER the wrapped error surfaces.
 *
 * Protocol for the caller (inbound.ts): call `takePersistenceFailure()` once
 * BEFORE the decrypt to discard anything stale — otherwise a leftover record
 * from an earlier operation would launder a real tamper into "transient" —
 * and again after a decrypt throws. Non-null means local persistence failed:
 * do NOT mark the frame seen, do NOT ack; leave it queued so a retry can
 * decrypt it once the disk recovers. A module-level slot is sound here
 * because decrypts are serialized under ratchet.lock.
 */
let lastPersistenceFailure: Error | null = null;

export function takePersistenceFailure(): Error | null {
  const failure = lastPersistenceFailure;
  lastPersistenceFailure = null;
  return failure;
}

export function recordPersistenceFailure(err: unknown): void {
  lastPersistenceFailure = err instanceof Error ? err : new Error(String(err));
}

/**
 * The suffix a `writeFileAtomic` temp carries after `<target>.` — what this
 * module mints TODAY (12 hex chars of fresh entropy) plus what earlier builds
 * minted (the pid), which an upgrade may still find stranded on
 * disk. The sweeper that cleans stranded temps for a directory writeFileAtomic
 * writes into (msglog's `sweepQuarantineTemps`, under its own lock custody)
 * matches THIS, so the set of names minted here and the set swept there cannot
 * drift apart the way two literal regexes would — msglog states that exact
 * constraint for its own `tempFor`/`sweepStrandedTemps` pair.
 */
export const ATOMIC_TMP_SUFFIX_RE = /^(\d+|[0-9a-f]{12})\.tmp$/;

/**
 * Write a file atomically: temp in the same directory, then rename. `saveProfile` used to carry its own inline copy of
 * this pattern; it writes through here now.
 *
 * Every file written through this is either key material or ratchet state,
 * and a bare `writeFileSync` truncates before it writes — so a crash
 * mid-write leaves a TRUNCATED session record, which deserializes as garbage,
 * which the inbound path classifies as tamper and acks away. A power cut
 * could therefore destroy queued messages permanently. `rename` within one
 * directory is atomic: a reader sees the old record or the new one, never
 * half of either.
 *
 * The mode goes on the temp file because rename keeps the source's
 * permissions — a chmod after the rename would leave a world-readable window
 * over a private key.
 *
 * Atomic was not DURABLE. Registration wrote identity.json
 * this way, uploaded the public half, and reported success — with the private
 * key still in the page cache and the rename only in the directory's in-memory
 * metadata. A power cut in that window erases the only copy of a key the
 * server now holds immutably: the account exists
 * and nothing can ever prove it again. So the temp file's DATA is fsync'd
 * before the rename, and the DIRECTORY after it — a rename lives in directory
 * metadata and survives a crash only if the directory entry does.
 *
 * DURABLE is the default and the exception must argue for itself. Measured
 * 2026-07-29 (APFS, node 22, whose fsyncSync issues F_FULLFSYNC): ~4-40ms per
 * durable write. That is invisible on a per-message write, but registration
 * mints 100 one-time prekeys back to back — a multi-second synchronous stall
 * that also starved vitest's worker RPC. The exception is at `savePreKey`
 * (stores.ts), with its argument — and it is only HALF the story: the batch
 * it speeds up is made durable in one concurrent pass (`persistBatch`,
 * ~210ms measured) before the upload advertises the public halves. Nothing
 * else may take the shortcut without both the argument and the flush.
 *
 * 'durable-verified' is for the ONE write whose loss is a permanently
 * bricked account: identity.json. It differs from 'durable' twice over.
 * First, directory-fsync failures are NOT swallowed (see `fsyncDir`) — a
 * commit that cannot be verified must not report success, because the server
 * holds the public half immutably and a lost private half can never prove
 * the account again. Second, EVERY ancestor directory is fsynced up to the
 * filesystem root: registration `mkdir -p`s `$TACENDUM_HOME/<name>/`, and
 * syncing only the file's own directory leaves the ENTRY for that new
 * directory (and any recursively created ancestor) in in-memory metadata — a
 * power cut then loses the whole tree, identity.json's own fsync
 * notwithstanding. The walk is unconditional rather than tracking which
 * dirs mkdir created, because the dirs may have been created seconds ago by
 * a DIFFERENT process whose writeback has not happened; it runs once per
 * account ever, and measured ~5ms per directory.
 */
export function writeFileAtomic(
  target: string,
  data: string | Uint8Array,
  mode: { mode: number } = FILE_MODE,
  durability: 'durable' | 'crash-consistent' | 'durable-verified' = 'durable',
): void {
  // The try/catch exists for the caller that CANNOT see this error: libsignal
  // wraps a store callback's throw in LibSignalErrorBase, and the inbound
  // path was classifying a mid-decrypt EIO here as tamper — acking away the
  // server's copy of a valid message. Recording before rethrowing is what
  // lets `takePersistenceFailure()` tell the two apart.
  try {
    // RANDOM suffix, O_EXCL, O_NOFOLLOW. The
    // name used to be `<target>.<pid>.tmp` — computable by anything on the
    // machine — and the 'w' open FOLLOWED a pre-planted symlink: key material
    // written through the link to wherever it pointed, then the link itself
    // renamed onto the target. The 0700 parent directory is why that never
    // crossed a user boundary; O_EXCL|O_NOFOLLOW is why it now cannot — a
    // planted file or symlink, wherever it points, answers EEXIST instead of
    // being followed, and nothing this call did not create is written through
    // or (see the catch below) deleted. O_EXCL alone would have traded the
    // hole for an outage: a strand left by a crashed process plus a recycled
    // pid makes every later write of that target fail forever. The suffix is
    // therefore fresh entropy per WRITE, which no strand can collide with.
    // Anything that changes this name's shape must keep ATOMIC_TMP_SUFFIX_RE
    // matching it, or the sweep that cleans stranded plaintext goes blind.
    const tmp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
    const fd = openSync(
      tmp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode.mode,
    );
    // From here the temp is provably OURS (O_EXCL), so a failure before the
    // rename consumes it must not strand it: session and prekey temps are key
    // material, and a strand is retained bytes no reader ever lists. Cleanup
    // is best-effort — the failure already in flight is the story — and a
    // SIGKILL between open and catch still strands, which is what the
    // directory owners' sweeps and the suffix's collision-immunity are for.
    try {
      try {
        writeFileSync(fd, data);
        if (durability !== 'crash-consistent') fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, target);
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        /* ENOENT, or a disk refusing the unlink — either way the error that
         * matters is the one about to rethrow. */
      }
      throw err;
    }
    if (durability === 'durable') fsyncDir(dirname(target));
    if (durability === 'durable-verified') {
      for (let dir = dirname(target); ; dir = dirname(dir)) {
        fsyncDir(dir, 'strict');
        if (dir === dirname(dir)) break; // filesystem root fsynced last
      }
    }
  } catch (err) {
    recordPersistenceFailure(err);
    throw err;
  }
}

/**
 * Persist a completed rename by fsyncing the directory that holds it.
 *
 * EINVAL/EPERM/ENOTSUP are how some filesystems answer "fsync a directory"
 * (and EISDIR is Windows refusing to open one at all): on those, the rename is
 * as durable as that filesystem can make it, and failing the whole write over
 * the quirk would turn a durability upgrade into an availability outage — the
 * data fsync above already succeeded. Anything else (EIO, ENOSPC) is the disk
 * saying the rename may NOT have survived, so it always propagates.
 *
 * 'strict' swallows NOTHING, quirk errnos included — reserved for the
 * identity commit, where "the filesystem cannot verify this" and "the rename
 * did not survive" must both refuse: the quirk swallow was converting an
 * UNVERIFIABLE identity commit into reported success, and an identity lost
 * after the server pinned its public half is a permanently bricked account
 *. On a filesystem that genuinely cannot fsync a directory,
 * strict makes registration fail loudly there instead of gambling the one
 * unrecoverable key — the mandated trade.
 */
export function fsyncDir(dir: string, strictness: 'lenient' | 'strict' = 'lenient'): void {
  const benign = new Set(['EINVAL', 'EPERM', 'ENOTSUP', 'EISDIR']);
  let fd: number;
  try {
    fd = openSync(dir, 'r');
  } catch (err) {
    if (strictness === 'lenient' && benign.has((err as NodeJS.ErrnoException).code ?? '')) return;
    throw err;
  }
  try {
    fsyncSync(fd);
  } catch (err) {
    if (strictness === 'strict' || !benign.has((err as NodeJS.ErrnoException).code ?? '')) {
      throw err;
    }
  } finally {
    closeSync(fd);
  }
}
