/**
 * The CLI's block list.
 *
 * One file, one shape, one question: `state/<name>/blocked.json`, a JSON
 * array of user ids, answering "is this sender blocked?". It is consulted at
 * the inbound seam, keyed on `frame.from` — which is what makes the rule
 * generalise to rooms with no further code, exactly as the blocking gate table
 * promises: a group message's sender IS `frame.from`, so the same lookup
 * suppresses both.
 *
 * WHAT SUPPRESSION MEANS HERE, mirrored from the app's gates:
 *   - decrypt and ACK byte-identically (`mayDecryptInbound`/`mustAckInbound`
 *     are always true — ratchet health; a block that changed ack behaviour
 *     would be visible to the blocked party, the exact tell the module
 *     exists to prevent);
 *   - persist and display NOTHING (`mayPersistInbound`: their traffic
 *     decrypts, then drops — no spool row, no stdout line, no stderr note);
 *   - room STATE still applies. This is deliberate and load-bearing: the
 *     fold is a pure function of the received writes, and every phone must
 *     reach the SAME roster. A client that dropped a blocked member's
 *     roster writes from the fold would diverge from every other member and
 *     ring the equivocation banner on honest traffic forever. Blocking
 *     silences a person; it must never fork a room's arithmetic.
 *
 * The file is read per frame rather than cached: `listen` is long-running,
 * and an operator editing the file mid-session should not need a restart.
 *
 * ABSENT AND CORRUPT ARE NOT THE SAME THING, and the difference is the whole
 * of this module's failure design. No file means nobody is blocked, which is
 * the ordinary state and says nothing. A file that EXISTS and will not parse
 * means the operator asked for something this process cannot honour, and it
 * is a safety control — so it fails open (fail-closed would swallow every
 * sender's traffic on one bad byte, and a block list that silences everyone
 * is worse than one that silences nobody) but it says so, loudly, once per
 * process. Silence there was the original shape and it is the one thing this
 * module must not do: a blocked person's messages reappearing with no
 * explanation is indistinguishable from the block never having been set.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './config.js';

export const BLOCKED_FILE = 'blocked.json';

export function blockedPath(name: string): string {
  return join(stateDir(name), BLOCKED_FILE);
}

/**
 * Warned-about accounts, so a long-running `listen` does not print the same
 * complaint on every inbound frame. Per process, not per file read: the point
 * is that the operator learns once, not that they are nagged.
 */
const warned = new Set<string>();

/** Every id this account has blocked. Never throws. */
export function loadBlocked(name: string): ReadonlySet<string> {
  const path = blockedPath(name);
  // No file is the ordinary state and is not worth a word.
  if (!existsSync(path)) return new Set();
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('not a JSON array of user ids');
    return new Set(parsed.filter((v): v is string => typeof v === 'string'));
  } catch (err) {
    if (!warned.has(name)) {
      warned.add(name);
      // stderr, not stdout: a `listen` piped into a tool must not gain a line
      // that looks like a message. Named plainly, because the operator has to
      // be able to fix the file.
      process.stderr.write(
        `tacendum: ${path} could not be read (${
          err instanceof Error ? err.message : String(err)
        }) — NOBODY is blocked for "${name}" until it is valid JSON\n`,
      );
    }
    return new Set();
  }
}

/** Test seam: forget which accounts have been warned about. */
export function resetBlockedWarnings(): void {
  warned.clear();
}

/** Is this sender blocked by this account? Never throws. */
export function isBlocked(name: string, userId: string): boolean {
  return loadBlocked(name).has(userId);
}
