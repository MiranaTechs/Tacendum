import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withFileLock } from '../src/lock.js';
import { CliError } from '../src/exit.js';

/**
 * The lock stolen while its token was incomplete.
 *
 * The sequence, first produced with SIGSTOP: process A claims the lock but
 * stalls before its token is complete; B classifies the fragment as dead and
 * legitimately takes a replacement lock; A resumes, finishes writing a file
 * nothing names any more, and returns "acquired" — two processes inside one
 * ratchet read-modify-write, the exact corruption the lock exists to prevent.
 * And if A's resumed write THREW instead, its failure cleanup removed the
 * lock path, which by then was B's lock.
 *
 * An earlier review changed the shape but not the danger. `lockPath` is a
 * DIRECTORY; a claim is a single-use entry `<seq>.<nonce>` inside it; the
 * staging file is dot-prefixed and is not a claim. So "the lock pathname held
 * a fragment" becomes "a HOLDER ENTRY held a fragment", and "the thief took
 * the pathname" becomes "our ticket was collected while we waited" — after
 * which the claimer must rejoin the queue rather than report a success it no
 * longer has.
 *
 * SIGSTOP does not fit in a unit test, so each window is reproduced
 * deterministically through the fs seam: the steal is injected at the
 * instant the ticket lands, short writes land one byte per call, and the
 * write fault is thrown by the mock. The ASSERTIONS are about outcomes —
 * whose token the critical section ran under, which files survived — never
 * about which syscalls produced them. (The injection hooks are necessarily
 * coupled to the syscalls the implementation makes; if acquisition stops
 * publishing its token file via link(), move the hooks, keep the
 * assertions.)
 */

const ctl = vi.hoisted(() => ({
  failWrites: false,
  chunk: false,
  /** Photographs of every HOLDER ENTRY's bytes in `observePath`, taken after
   * each landed write and after each publish. */
  observations: null as string[] | null,
  observePath: null as string | null,
  /** Fired after a link lands — the instant a claimer's ticket becomes
   * visible, which is where the SIGSTOP in the original repro bit. */
  afterLink: null as (() => void) | null,
}));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  // Inlined rather than shared with the helpers below: a vi.mock factory may
  // not close over the test module's own bindings.
  const entryRe = /^\d{12}\.[0-9a-f]{32}$/;
  const observe = (): void => {
    if (ctl.observations === null || ctl.observePath === null) return;
    let names: string[];
    try {
      names = real.readdirSync(ctl.observePath).filter((n) => entryRe.test(n));
    } catch {
      return; // no lock directory yet, so no holder entry can be visible
    }
    for (const name of names.sort()) {
      try {
        ctl.observations.push(real.readFileSync(`${ctl.observePath}/${name}`, 'utf8'));
      } catch {
        ctl.observations.push('<absent>');
      }
    }
  };
  const writeSync: typeof real.writeSync = ((
    fd: number,
    data: string | NodeJS.ArrayBufferView,
    a?: unknown,
    b?: unknown,
    c?: unknown,
  ): number => {
    if (ctl.failWrites) {
      const err = new Error('ENOSPC: fake quota boundary') as NodeJS.ErrnoException;
      err.code = 'ENOSPC';
      throw err;
    }
    let n: number;
    if (typeof data === 'string') {
      n = real.writeSync(fd, ctl.chunk ? data.slice(0, 1) : data);
    } else {
      const view = data as Uint8Array;
      const off = (a as number | undefined) ?? 0;
      const want = (b as number | undefined) ?? view.byteLength - off;
      n = real.writeSync(
        fd,
        view,
        off,
        ctl.chunk ? Math.min(1, want) : want,
        c as number | null,
      );
    }
    observe();
    return n;
  }) as typeof real.writeSync;
  const linkSync: typeof real.linkSync = (src, dst) => {
    real.linkSync(src, dst);
    // ONLY a holder entry counts as "the ticket landed". Acquisition also
    // link()s a dot-prefixed DOORWAY marker before it reads the queue (the
    // bakery `choosing` flag), and firing the steal there hands the thief an
    // empty queue: it removed `holderEntries(...)[0] ?? ''`, i.e. the lock
    // DIRECTORY itself, and acquisition died on EISDIR instead of
    // re-contending. The hook is coupled to the syscalls, as the header says;
    // the assertions below are not.
    const name = String(dst).split('/').pop() ?? '';
    if (entryRe.test(name)) {
      const hook = ctl.afterLink;
      if (hook) hook();
    }
    observe();
  };
  return { ...real, writeSync, linkSync };
});

/** The implementation's own holder-name shape. Duplicated rather than
 * imported: a test that reads the rule off the code under test cannot catch
 * the code changing the rule. */
const ENTRY_RE = /^\d{12}\.[0-9a-f]{32}$/;

/** The lock's holder entries, in queue order. */
function holderEntries(lockPath: string): string[] {
  try {
    return readdirSync(lockPath)
      .filter((name) => ENTRY_RE.test(name))
      .sort();
  } catch {
    return [];
  }
}

/** Plant another process's claim by hand. `nonce` is pinnable because queue
 * position is lexical and some of these tests need the planted entry to sit
 * definitively ahead of whatever ticket the claimer takes next. Returns the
 * entry's name. */
function plantEntry(
  lockPath: string,
  opts: { token: string; ageMs?: number; seq?: number; nonce?: string },
): string {
  mkdirSync(lockPath, { recursive: true, mode: 0o700 });
  const nonce = opts.nonce ?? randomBytes(16).toString('hex');
  const name = `${String(opts.seq ?? 1).padStart(12, '0')}.${nonce}`;
  writeFileSync(join(lockPath, name), opts.token, { mode: 0o600 });
  if (opts.ageMs !== undefined) {
    const then = (Date.now() - opts.ageMs) / 1000;
    utimesSync(join(lockPath, name), then, then);
  }
  return name;
}

/** Comfortably past LOCK_STALE_MS, which is 30 seconds. */
const HOUR_MS = 3_600_000;

/** A complete token: pid, incarnation, 8 random bytes as hex. */
const COMPLETE = /^\d+:[^:]+:[0-9a-f]{16}$/;

let dir: string;
let lockPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tacendum-lock3-'));
  lockPath = join(dir, 'ratchet.lock');
});
afterEach(() => {
  ctl.failWrites = false;
  ctl.chunk = false;
  ctl.observations = null;
  ctl.observePath = null;
  ctl.afterLink = null;
  rmSync(dir, { recursive: true, force: true });
});

/** A dead writer's token: no live process wears this pid on macOS (pid_max
 * 99998); where one could, the incarnation 'x' can never match a real
 * probe's, so it is dead either way. */
const THIEF_TOKEN = `999999:x:${'ef'.repeat(8)}`;

describe('a claim whose ticket was taken must not report success', () => {
  it('re-contends instead of entering the critical section beside the thief', () => {
    let steals = 0;
    let stolen = '';
    ctl.afterLink = () => {
      // The thief, making exactly the real stealer's moves at the instant
      // the victim's ticket becomes visible — the deterministic stand-in for
      // "B judged the stalled claimer abandoned and collected its entry".
      // The thief's own writer is dead on arrival (see THIEF_TOKEN) and its
      // entry backdated, so the victim can legitimately recover within the
      // test's lifetime. The all-zero nonce sorts below any real one, so the
      // thief is unambiguously AHEAD of the victim's next ticket: it has to
      // be judged and collected, not stepped over by luck of the draw.
      ctl.afterLink = null;
      steals += 1;
      stolen = holderEntries(lockPath)[0] ?? '';
      rmSync(join(lockPath, stolen), { force: true });
      plantEntry(lockPath, { token: THIEF_TOKEN, ageMs: HOUR_MS, nonce: '0'.repeat(32) });
    };
    let seen = '';
    let heldDuringWork: string[] = [];
    withFileLock(lockPath, () => {
      heldDuringWork = holderEntries(lockPath);
      if (heldDuringWork.length === 1) {
        seen = readFileSync(join(lockPath, heldDuringWork[0] as string), 'utf8');
      }
    });
    // The window really was injected — a refactor that dodges the hook must
    // fail here loudly rather than pass an empty scenario.
    expect(steals).toBe(1);
    expect(stolen).not.toBe('');
    // Exactly one holder entry stood in the directory while the critical
    // section ran, and it is a ticket taken AFTER the theft. Before the fix
    // the victim returned "acquired" holding a name that no longer existed,
    // beside a thief that did: two holders.
    expect(heldDuringWork).toHaveLength(1);
    expect(heldDuringWork[0]).not.toBe(stolen);
    // And that entry carries a complete token THIS process wrote, never the
    // thief's.
    expect(seen).toMatch(COMPLETE);
    expect(Number(seen.split(':')[0])).toBe(process.pid);
    expect(seen).not.toBe(THIEF_TOKEN);
    // Its release removed only the ticket it re-acquired, and the thief's
    // abandoned entry was collected on the way in.
    expect(readdirSync(lockPath)).toEqual([]);
  }, 20_000);
});

describe('the token is visible whole or not at all', () => {
  it('never lets a HOLDER ENTRY hold a fragment, even at one byte per write', () => {
    // One byte per writeSync, as at a quota boundary, with every holder entry
    // in the lock directory photographed after each landed byte and after the
    // publish. The poisonous fragment this pins: a token torn just after its
    // second ':' is byte-shaped like the complete legacy `pid:hex` token, and
    // a legacy token is honoured for as long as ANYTHING wears its pid — so a
    // fragment outliving a crashed writer is an unbounded wedge, and one
    // caught mid-write invites the steal-while-incomplete race above. The
    // bytes are therefore staged in the dot-prefixed private file, which is
    // not a holder, and published whole with link().
    ctl.chunk = true;
    const photos: string[] = [];
    ctl.observations = photos;
    ctl.observePath = lockPath;
    withFileLock(lockPath, () => 'ok');
    ctl.chunk = false;
    ctl.observations = null;
    expect(photos.length).toBeGreaterThan(0);
    const fragments = photos.filter((p) => !COMPLETE.test(p));
    expect(fragments, 'partial tokens were visible at a holder entry').toEqual([]);
    // Sanity that the camera works: the published token itself was seen.
    expect(photos.some((p) => COMPLETE.test(p))).toBe(true);
  });
});

describe('release removes only the very file acquisition created', () => {
  /**
   * REWRITTEN, an earlier review, and the two tests that stood here are gone
   * rather than adjusted — they asserted a mechanism that had to be deleted.
   *
   * They built a REPLACEMENT file by hand at the holder's own entry name
   * (once with different bytes, once with identical bytes) and required
   * `release` to leave it alone. That was the right requirement under the
   * design where a lock lived at one REUSABLE pathname: a process classified
   * dead really could find someone else's live lock at its path, so release
   * had to re-open the file and check its dev/ino and its token before
   * unlinking.
   *
   * Under single-use `<seq>.<nonce>` names that scenario is not merely
   * unlikely, it is not constructible: the name carries 128 bits of entropy
   * and is never minted twice, so the handle's path is this call's own entry
   * or it is nothing. Keeping the check cost more than it bought — openSync
   * throws EMFILE, not ENOENT, at a descriptor ceiling, and the blanket catch
   * read that as "not provably ours, leave it", stranding an entry with the
   * process's own live pid in it and wedging the account for the rest of that
   * process's life. So release unlinks by name, and what these tests now pin
   * is the PREMISE that licenses it.
   */
  it('never mints an entry name twice, so the handle can name nothing else', () => {
    // The premise, stated as an outcome: across many acquisitions no name
    // recurs, and no nonce recurs. If a future change ever derived the name
    // from something reusable — the pid, a counter, a fixed nonce — this
    // fails here, at the invariant, rather than as a mystery double-writer.
    const names: string[] = [];
    const heldCounts = new Set<number>();
    for (let i = 0; i < 200; i++) {
      withFileLock(lockPath, () => {
        const held = holderEntries(lockPath);
        heldCounts.add(held.length);
        names.push(held[0] ?? '');
      });
    }
    expect([...heldCounts], 'the critical section ran with other than one holder').toEqual([1]);
    expect(new Set(names).size, 'an entry name was minted twice').toBe(names.length);
    const nonces = names.map((n) => n.slice(13));
    expect(new Set(nonces).size, 'a nonce was minted twice').toBe(nonces.length);
  }, 30_000);

  it('unlinks its entry even when the entry can no longer be opened', () => {
    // The wedge the old verification produced, in its simplest form: make the
    // entry unopenable and require release to remove it anyway. A release
    // that reads before it unlinks cannot pass this, and a release that
    // cannot pass this leaves a live-pid entry behind at every fd ceiling.
    // (The fd-exhaustion form is driven through an EMFILE-throwing openSync
    // in gate.lock4.test.ts; here the file is simply chmod'ed away.)
    let mineName = '';
    withFileLock(lockPath, () => {
      mineName = holderEntries(lockPath)[0] ?? '';
      chmodSync(join(lockPath, mineName), 0o000);
    });
    expect(mineName).not.toBe('');
    expect(readdirSync(lockPath), 'release stranded an unreadable entry').toEqual([]);
  });

  it('is a no-op when the entry was already collected as abandoned', () => {
    // The other direction: a claimer that stalled past LOCK_STALE_MS has its
    // ticket collected by the next winner, so finding nothing at the handle's
    // path is a legitimate outcome and must not throw out of the caller's
    // `finally` — which would replace the real error with an ENOENT.
    expect(() =>
      withFileLock(lockPath, () => {
        rmSync(join(lockPath, holderEntries(lockPath)[0] as string), { force: true });
      }),
    ).not.toThrow();
    expect(readdirSync(lockPath)).toEqual([]);
  });
});

describe("a failed token write cannot take anyone else's lock with it", () => {
  it("surfaces the error and leaves the current holder's entry exactly as it was", () => {
    // Second half of the same defect: the write-failure cleanup once removed the
    // LOCK pathname — which after a steal is the NEW holder's lock. The
    // only file a failed claim may remove is its own private staging file.
    // Note the holder is planted as an ENTRY: a plain file at `lockPath` is
    // now the pre-redesign shape, and acquisition would refuse at the
    // directory check without ever reaching the token write this pins.
    const holder = `999999:x:${'cd'.repeat(8)}`;
    const holderName = plantEntry(lockPath, { token: holder });
    ctl.failWrites = true;
    let err: unknown;
    try {
      withFileLock(lockPath, () => 'must not run');
    } catch (e) {
      err = e;
    }
    ctl.failWrites = false;
    expect(err).toBeInstanceOf(CliError);
    expect(readFileSync(join(lockPath, holderName), 'utf8')).toBe(holder);
    // No claim remnants either: every non-crash exit sweeps its staging.
    expect(readdirSync(lockPath)).toEqual([holderName]);
  });

  it('leaves nothing behind after a successful hold either', () => {
    withFileLock(lockPath, () => 'ok');
    // The lock DIRECTORY survives, and must: re-creating it per claim would
    // put a reusable pathname back at the centre of the design. What may not
    // survive is anything inside it — no holder entry, no staging file.
    expect(readdirSync(lockPath)).toEqual([]);
    expect(readdirSync(dir)).toEqual(['ratchet.lock']);
  });
});
