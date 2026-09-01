import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PreKeyRecord } from '@signalapp/libsignal-client';
import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * INVARIANT HARNESS — N processes, one account directory, nothing lost.
 *
 * Every invariant below was violated by code that shipped, and each was found
 * by a human reviewer rather than by a test:
 *
 *  1. Two concurrent registrations minted OVERLAPPING prekey batches and
 *     clobbered each other's files, so the server was handed public keys whose
 *     private halves no longer existed — a sender given one of those can never
 *     be decrypted, and the inbound path acks that message away as poison.
 *  2. Two concurrent renewals both minted, and `POST /v1/auth` revokes all
 *     prior sessions (one account, one live token), so whichever process
 *     retried held a dead token — and a late profile write could leave the
 *     REVOKED token on disk for every later invocation.
 *  3. A lock left behind wedges the account; a lock held by two processes at
 *     once corrupts the thing it guards.
 *
 * The shape of the product is what makes this a real risk rather than a
 * curiosity: a Makefile with `-j`, a cron line beside a live `listen`, and a
 * Claude Code hook that fires whenever the agent stops all address the same
 * account directory with no coordination beyond these files.
 *
 * WHY A HARNESS. A single hand-picked interleaving proves nothing about a race:
 * it either happens to hit the window or it does not. So the mock API injects
 * DELAY WITH VARIANCE and several iterations run, sampling different orderings,
 * and the assertions are global properties over everything every process did —
 * "no id was issued twice", "every published key opens with the private half
 * on this disk" — rather than an expectation about one process's output.
 *
 * OUTCOMES, NOT MECHANISMS. An earlier revision asserted that the
 * whole challenge-to-upload interval was serialized, by watching the mock's
 * in-flight counter. That is a claim about HOW the code is correct, and a
 * correct refactor — one that reserved disjoint key ranges atomically and let
 * challenge requests overlap — would have failed it. The test is gone; the
 * properties it was standing in for (no duplicate ids, no orphaned key, no
 * published key whose bytes differ from the stored record, no dead token) are
 * asserted directly on what the processes actually did — and the sabotage
 * runs below show they carry it: every lock-neutering that used to trip the
 * in-flight counter now trips a decryptability outcome instead.
 *
 * NON-VACUITY, verified by sabotage rather than asserted. Each sabotage typechecked and ran, so the failures are the
 * properties biting rather than a broken build:
 *
 *  - `apiUploadKeys` replaced with a successful no-op: every register still
 *     exited 0, and the harness failed with "12 registers exited 0 but the
 *     server accepted 0 key batches — success without publication: expected
 *     +0 to be 12". The previous revision PASSED this sabotage (its duplicate
 *     and orphan checks ran over an empty list), which is why success is now
 *     tied to the batch the server actually recorded.
 *  - upload sabotaged to publish a DIFFERENT public key under each stored id
 *     (private key A on disk, public key B on the wire): failed with
 *     "these published keys can never be answered by what is on disk:
 *     [{ keyId: 101, why: 'published public key is not the public half of
 *     the stored PRIVATE key' }, …]". The previous revision compared
 *     FILENAMES, so it passed while every ciphertext a sender produced would
 *     have been undecryptable.
 *  - every stored record rewritten as
 *     `PreKeyRecord.new(id, <the published public key>, <a fresh private
 *     key>)` — the record libsignal accepts without checking its halves
 *     against each other. Property (4) failed with 800 entries reading
 *     "published public key is not the public half of the stored PRIVATE
 *     key". Against the previous revision's `publicKey()` derivation the same
 *     sabotage was invisible: the embedded half IS the wire bytes, so it
 *     passed with a whole account's worth of unanswerable keys published.
 *  - `auth.lock` removed from `AuthSession.mint()`: the renewal fleet failed
 *     with "3 of 4 processes came out of a shared renewal with dead
 *     credentials (server saw 5 mints, rejected 7 binds)", each failure's
 *     stderr showing `POST /v1/integrations/bind failed: 401 unauthorized:
 *     stale token` after its one retry. The previous revision only ever
 *     renewed under `register`, whose own lock serialized the mints
 *     upstream, so removing auth.lock kept it green.
 *  - `register.lock` pointed at a per-pid path (every acquisition succeeds,
 *     none excludes): failed with "800 published keys have no private half
 *     on disk: [101, 102, …]" — the unpublished-batch reclaim deletes a
 *     rival's not-yet-published files exactly as the lock's own comment
 *     predicts a prune would, and the orphan OUTCOME catches it where the
 *     deleted in-flight counter merely observed the overlap.
 *  - the ratchet lock per-pid as well (the one that guards id allocation):
 *     failed with "these keyIds were published more than once — two batches
 *     collided: [1005, 1006, …]".
 *
 * NOT COVERED, deliberately: a genuine multi-machine race (these locks are
 * filesystem-local by construction, and the server's own one-token invariant is
 * the backstop there); the ratchet's encrypt/decrypt path under concurrency,
 * which needs two live sockets and is held by harness.acksafety.test.ts and
 * gate.lock.test.ts; and thread-level interleavings inside one process, which
 * Node's single-threaded model makes unreachable for this code.
 */

const CLI = join(process.cwd(), 'packages/cli/src/main.ts');
const NAME = 'fleetbot';
const USER_ID = '01HFLEETAAAAAAAAAAAAAAAAAA';

/** Concurrent registrations per iteration, and iterations. Bounded so the whole
 * file stays inside a CI budget while still sampling several orderings. */
const FLEET = 4;
const ITERATIONS = 3;

/** The renewal fleet: processes that all wake up holding the same EXPIRED
 * token, which is the `make -j` fan-out on the day the session dies. */
const RENEWERS = 4;
const RENEWAL_ITERATIONS = 2;

let home = '';

interface Mint {
  token: string;
  at: number;
}

/** One entry of an accepted `PUT /v1/keys` batch, as the server saw it. The
 * `pub` bytes are the point: a mock that discards them can only
 * compare FILENAMES, and "an id exists on disk" is satisfiable by a private
 * key that does not match the public key senders will encrypt to. */
interface PublishedKey {
  keyId: number;
  pub: string;
}

/**
 * The mock API, faithful on the one behaviour that makes this dangerous: a mint
 * REVOKES every earlier token, and it does so at request ARRIVAL, before the
 * reply is sent. The revocation must exist server-side while the response is
 * still in flight, because that is exactly the window a second process races.
 *
 * `delayFor` is per-route so the renewal test can hold `/v1/auth` open long
 * enough that unserialized mints would certainly overlap, without slowing
 * every other route to match.
 */
function makeApi(
  delayFor: (url: string) => number,
  opts: { accountClass?: 'integration' } = {},
) {
  let live = '';
  let expiries = 0;
  const mints: Mint[] = [];
  /** Every accepted key batch, in arrival order — one per accepted PUT, so
   * "success without publication" is detectable, not just duplicates. */
  const batches: PublishedKey[][] = [];
  let keysRejected = 0;
  let bindsRejected = 0;

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const reply = (code: number, payload: unknown): void => {
        const send = (): void => {
          res.writeHead(code, { 'content-type': 'application/json' });
          res.end(JSON.stringify(payload));
        };
        const d = delayFor(req.url ?? '');
        if (d > 0) setTimeout(send, d);
        else send();
      };
      // Exact match, not endsWith: `tok-1` is a suffix-shaped trap once the
      // mint counter passes ten, and a mock that matches suffixes can bless a
      // token the server never issued.
      const bearerIsLive = (req.headers.authorization ?? '') === `Bearer ${live}`;

      if (req.url === '/v1/auth/challenge') {
        reply(200, {
          challenge: Buffer.from('nonce-for-the-fleet').toString('base64'),
          expiresAt: Math.floor(Date.now() / 1000) + 120,
        });
        return;
      }
      if (req.url === '/v1/auth') {
        live = `tok-${mints.length + 1}`;
        mints.push({ token: live, at: Date.now() });
        reply(200, {
          userId: USER_ID,
          authToken: live,
          ...(opts.accountClass ? { accountClass: opts.accountClass } : {}),
        });
        return;
      }
      if (req.url === '/v1/keys') {
        // The token must be the LIVE one. A process uploading under a token a
        // sibling's mint already revoked is defect (2) in its observable form.
        if (!bearerIsLive) {
          keysRejected += 1;
          reply(401, { error: { code: 'unauthorized', detail: 'stale token' } });
          return;
        }
        const parsed = JSON.parse(body) as {
          oneTimePrekeys?: { keyId?: number; pub?: string }[];
        };
        // Only well-formed entries are recorded, so a payload whose field
        // names drifted (or a harness parsing the wrong field — the earlier
        // vacuity) shows up as a batch SMALLER than the register claimed,
        // which the publication property below refuses.
        batches.push(
          (parsed.oneTimePrekeys ?? []).flatMap((p) =>
            Number.isInteger(p.keyId) && typeof p.pub === 'string' && p.pub.length > 0
              ? [{ keyId: p.keyId as number, pub: p.pub }]
              : [],
          ),
        );
        reply(200, {});
        return;
      }
      if (req.url === '/v1/integrations/bind') {
        // Same live-token rule as /v1/keys: this is the authed route the
        // renewal fleet exercises, and a stale bearer here is exactly what a
        // process holds after a sibling's mint revoked it.
        if (!bearerIsLive) {
          bindsRejected += 1;
          reply(401, { error: { code: 'unauthorized', detail: 'stale token' } });
          return;
        }
        reply(200, {});
        return;
      }
      reply(404, { error: { code: 'not_found', detail: 'unmocked' } });
    });
  });

  return {
    server,
    batches,
    mints,
    publishedIds: (): number[] => batches.flat().map((k) => k.keyId),
    liveToken: () => live,
    rejected: () => keysRejected,
    bindsRejected: () => bindsRejected,
    /** Revoke the live token out from under everyone — the day-31 expiry. */
    expire: (): void => {
      expiries += 1;
      live = `expired-${expiries}`;
    },
  };
}

function runCli(
  base: string,
  homeDir: string,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // Always --json: the fleet test reads the register's own success record
    // (its claimed prekey count) back off stdout to bind it to what the mock
    // actually accepted.
    const child = spawn(process.execPath, ['--import', 'tsx', CLI, ...args, '--json'], {
      env: {
        ...process.env,
        TACENDUM_HOME: homeDir,
        TACENDUM_API: base,
        TACENDUM_WS: 'ws://127.0.0.1:9/ws',
        NODE_USE_SYSTEM_CA: '0',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.end();
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** The one JSON record a `--json` command prints as its result. */
function resultRecord(stdout: string): { oneTimePrekeys?: number } {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  try {
    return JSON.parse(lines[lines.length - 1] ?? '') as { oneTimePrekeys?: number };
  } catch {
    return {};
  }
}

/** The private halves this machine actually holds. */
function heldPrekeyIds(homeDir: string, name: string): number[] {
  const dir = join(homeDir, name, 'prekeys');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.bin'))
    .map((f) => Number(f.slice(0, -4)))
    .filter((n) => Number.isInteger(n));
}

function storedToken(homeDir: string, name: string): string {
  const p = join(homeDir, name, 'profile.json');
  if (!existsSync(p)) return '';
  return (JSON.parse(readFileSync(p, 'utf8')) as { authToken?: string }).authToken ?? '';
}

/** Any lock file left behind after every process has exited is a wedge: the
 * next invocation waits out the full timeout and then refuses. */
/**
 * Locks whose HOLDER outlived the process that took it.
 *
 * Not "lock paths that exist": since lock.ts moved to single-use pathnames, a
 * `*.lock` is a DIRECTORY that survives every holder by design, so testing for
 * its presence became a tautology that reports a wedge on every healthy run —
 * and, worse, would have gone on passing once inverted, because an empty
 * directory and a held one look identical from outside. A wedge is a HOLDER
 * ENTRY left behind, which is what the next process actually waits on.
 *
 * The entry pattern is duplicated here rather than imported from lock.ts on
 * purpose: a harness that reads the rule off the code it is checking cannot
 * catch that code changing the rule.
 */
const HOLDER_ENTRY = /^\d{12}\.[0-9a-f]{32}$/;

function strayLocks(homeDir: string, name: string): string[] {
  const out: string[] = [];
  for (const dir of [join(homeDir, name), join(homeDir, 'state', name)]) {
    if (!existsSync(dir)) continue;
    for (const lock of readdirSync(dir).filter((f) => f.endsWith('.lock'))) {
      const held = readdirSync(join(dir, lock)).filter((e) => HOLDER_ENTRY.test(e));
      // Report the lock by name, once, however many entries are queued on it.
      if (held.length > 0) out.push(`${lock} (${held.length} holder(s))`);
    }
  }
  return out;
}

afterAll(() => {
  if (home) rmSync(home, { recursive: true, force: true });
});

describe('a fleet of processes on one account directory', () => {
  it(
    'publishes exactly what it claims, never issues a prekey id twice, never publishes a key whose private half cannot answer, and never strands a revoked token',
    async () => {
      // Delay VARIANCE is the point: a fixed delay samples one ordering, and a
      // race that only opens on a particular interleaving would pass forever.
      // The sequence is fixed (not random) so a failure is reproducible.
      const delays = [0, 40, 8, 120, 4, 60, 200, 16];
      let call = 0;
      const api = makeApi(() => delays[call++ % delays.length] as number);
      await new Promise<void>((r) => api.server.listen(0, '127.0.0.1', r));
      const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;

      try {
        home = mkdtempSync(join(tmpdir(), 'tacendum-fleet-'));

        let succeededTotal = 0;
        let claimedTotal = 0;
        for (let iter = 0; iter < ITERATIONS; iter++) {
          const runs = await Promise.all(
            Array.from({ length: FLEET }, () => runCli(base, home, ['register', NAME])),
          );

          // A refusal is ALLOWED — losing the register lock is the designed,
          // safe outcome and `register` is idempotent and cron-retried. What is
          // never allowed is a process reporting SUCCESS on a batch the machine
          // cannot answer, so successes are what the properties below bind.
          const succeeded = runs.filter((r) => r.code === 0);
          expect(
            succeeded.length,
            `iteration ${iter}: every process failed — the fleet proves nothing.\n` +
              runs.map((r) => r.stderr.slice(0, 200)).join('\n---\n'),
          ).toBeGreaterThan(0);

          // Nobody may exit 2 (Claude Code's blocking hook code), whatever
          // happens under contention.
          for (const r of runs) expect(r.code, 'exit 2 is forbidden').not.toBe(2);

          // Each success CLAIMS a batch on its own stdout. The claim is what
          // ties exit 0 to publication below — a register that exits 0 while
          // claiming zero keys is the vacuous-success defect stated directly.
          for (const r of succeeded) {
            const claimed = resultRecord(r.stdout).oneTimePrekeys ?? 0;
            expect(
              claimed,
              'a register exited 0 while claiming no published one-time prekeys',
            ).toBeGreaterThan(0);
            claimedTotal += claimed;
          }
          succeededTotal += succeeded.length;
        }

        // (1) SUCCESS MEANS PUBLICATION (an earlier revision — the previous revision let
        // a no-op upload pass, because its remaining properties quantified
        // over an empty list). Every exit-0 register must have landed exactly
        // one ACCEPTED /v1/keys batch, and the keys the server recorded must
        // number what the successes claimed — fewer means a batch was dropped
        // or half-parsed, more means an upload escaped its register.
        expect(
          api.batches.length,
          `${succeededTotal} registers exited 0 but the server accepted ` +
            `${api.batches.length} key batches — success without publication`,
        ).toBe(succeededTotal);
        const publishedIds = api.publishedIds();
        expect(
          publishedIds.length,
          `the successes claimed ${claimedTotal} one-time prekeys but the server ` +
            `recorded ${publishedIds.length} well-formed ones`,
        ).toBe(claimedTotal);

        // (2) NO ID ISSUED TWICE, across every process and every iteration.
        // Two registrations that overlapped used to mint the same range and
        // overwrite each other's files.
        const dupes = publishedIds.filter((id, i) => publishedIds.indexOf(id) !== i);
        expect(
          [...new Set(dupes)].slice(0, 10),
          'these keyIds were published more than once — two batches collided',
        ).toEqual([]);

        // (3) EVERY PUBLISHED KEY HAS ITS PRIVATE HALF. This is the property
        // that actually protects a message: the server hands out what was
        // published, and a key we cannot answer becomes a ciphertext that never
        // decrypts and is then acked away.
        const held = new Set(heldPrekeyIds(home, NAME));
        const orphaned = [...new Set(publishedIds)].filter((id) => !held.has(id));
        expect(
          orphaned.slice(0, 10),
          `${orphaned.length} published keys have no private half on disk`,
        ).toEqual([]);

        // (4) THE PUBLISHED BYTES ARE WHAT THE PRIVATE HALF ON THIS DISK CAN
        // ANSWER (an earlier revision — the previous revision compared filenames, so
        // private key A under id 7 with public key B published as id 7 passed
        // while every sender encrypting to B produced ciphertext A can never
        // open). The comparison derives the public key from `privateKey()`,
        // NEVER from the record's own `publicKey()`.
        //
        // CONSTRAINT: a PreKeyRecord stores the two halves it was handed and
        // checks nothing between them. `PreKeyRecord.new(7, B.getPublicKey(),
        // A)` is a legal record whose `publicKey()` reads back B — so a
        // registration that stored that record and published B would satisfy
        // an embedded-half comparison exactly, while decryption uses A and
        // every ciphertext a sender encrypted to B is undecryptable forever
        // (and then acked away as poison). Deriving from the private half is
        // the only form of this check that asks the question the invariant is
        // about: can what is on this disk open what the server hands out?
        const badBytes: { keyId: number; why: string }[] = [];
        for (const { keyId, pub } of api.batches.flat()) {
          const path = join(home, NAME, 'prekeys', `${keyId}.bin`);
          if (!existsSync(path)) continue; // property (3) already reports these
          let derived = '';
          try {
            derived = Buffer.from(
              PreKeyRecord.deserialize(new Uint8Array(readFileSync(path)))
                .privateKey()
                .getPublicKey()
                .serialize(),
            ).toString('base64');
          } catch {
            badBytes.push({ keyId, why: 'stored record does not deserialize' });
            continue;
          }
          if (derived !== pub) {
            badBytes.push({
              keyId,
              why: 'published public key is not the public half of the stored PRIVATE key',
            });
          }
        }
        expect(
          badBytes.slice(0, 5),
          'these published keys can never be answered by what is on disk',
        ).toEqual([]);

        // (5) THE STORED TOKEN IS THE LIVE ONE. A revoked token left on disk
        // means every later invocation starts dead.
        expect(
          storedToken(home, NAME),
          'the profile holds a token the server has revoked',
        ).toBe(api.liveToken());

        // (6) NO LOCK SURVIVES its holder. A stray lock costs the next command
        // the full wait and then a refusal.
        expect(strayLocks(home, NAME), 'lock files left behind wedge the account').toEqual(
          [],
        );
      } finally {
        await new Promise((r) => api.server.close(r));
      }
    },
    240_000,
  );

  it(
    'brings every process of an expired fleet back alive through one shared renewal',
    async () => {
      // Defect (2) on the path where it actually races: the
      // previous revision drove every renewal through `register`, whose own
      // outer lock serialized the mints before auth.lock was ever contended —
      // so REMOVING auth.lock kept it green. `pair` is an ordinary
      // AuthSession-carrying command: it presents the stored token, takes the
      // 401, and renews — with nothing upstream to serialize it. N of them
      // starting from the same expired token is the day-31 `make -j` fan-out.
      //
      // `/v1/auth` is held open a few hundred ms with variance, because a
      // mint's revocation lands at request ARRIVAL: any two renewals inside
      // that window kill each other unless something orders them. The
      // assertions are OUTCOMES only — every process comes back alive, and
      // the token left on disk is the live one — so an implementation that
      // achieves them some other way than today's adopt-under-lock passes.
      const NAME2 = 'renewbot';
      const OWNER = '01HBBBBBBBBBBBBBBBBBBBBBBB';
      const authDelays = [320, 180, 260, 90];
      let authCall = 0;
      const api = makeApi(
        (url) =>
          url === '/v1/auth'
            ? (authDelays[authCall++ % authDelays.length] as number)
            : url === '/v1/auth/challenge'
              ? 40
              : 0,
        // `pair` refuses locally unless the profile records the integration
        // class, which the server states at auth time.
        { accountClass: 'integration' },
      );
      await new Promise<void>((r) => api.server.listen(0, '127.0.0.1', r));
      const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
      const dir = mkdtempSync(join(tmpdir(), 'tacendum-renew-'));

      try {
        const seed = await runCli(base, dir, ['register', NAME2, '--integration']);
        expect(
          seed.code,
          `the seeding register failed — the fleet below would prove nothing:\n${seed.stderr.slice(0, 400)}`,
        ).toBe(0);

        for (let iter = 0; iter < RENEWAL_ITERATIONS; iter++) {
          // Revoke the token every process is about to present, so each one's
          // first authed request 401s and the fleet renews CONCURRENTLY.
          api.expire();

          const runs = await Promise.all(
            Array.from({ length: RENEWERS }, () => runCli(base, dir, ['pair', NAME2, OWNER])),
          );

          for (const r of runs) expect(r.code, 'exit 2 is forbidden').not.toBe(2);

          // Unlike the register fleet, NO refusal is acceptable here: `pair`
          // (like `send`) retries its 401 exactly once with whatever the
          // renewal produced, so a process that still fails was left holding
          // a token a sibling's mint had revoked — the defect itself.
          const failed = runs.filter((r) => r.code !== 0);
          expect(
            failed.map((r) => `exit ${r.code}: ${r.stderr.slice(0, 200)}`),
            `iteration ${iter}: ${failed.length} of ${RENEWERS} processes came out of a ` +
              `shared renewal with dead credentials (server saw ${api.mints.length} mints, ` +
              `rejected ${api.bindsRejected()} binds)`,
          ).toEqual([]);

          // The shared on-disk value must be the LIVE token once the dust
          // settles: a revoked one stranded here starts every later
          // invocation dead — the second half of defect (2).
          expect(
            storedToken(dir, NAME2),
            `iteration ${iter}: the profile holds a token the server has revoked`,
          ).toBe(api.liveToken());

          expect(strayLocks(dir, NAME2), 'lock files left behind wedge the account').toEqual(
            [],
          );
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
        await new Promise((r) => api.server.close(r));
      }
    },
    240_000,
  );
});

/**
 * THE DOORWAY, kept as a property because review did not catch its absence.
 *
 * The single-use-pathname redesign shipped with a hole that two processes
 * starting within microseconds of each other can show: picking a ticket is a
 * READ of the queue followed by a WRITE to it, so two claimants that both read
 * an EMPTY queue both take ticket 1. Whichever publishes first sees only
 * itself and enters; the other then publishes a lower-sorting nonce, also sees
 * nothing ahead of it, and enters too. Both are right about what they saw —
 * one view was simply taken before the other claimant existed. Two writers in
 * one Double Ratchet read-modify-write, which is the corruption the whole
 * redesign was written to prevent.
 *
 * `lock.ts` answers it the way Lamport's bakery does: a claimant opens a DOOR
 * before it reads the queue and closes it only once published, and no one may
 * conclude the queue is empty ahead of them while a door is open.
 *
 * THIS TEST DRIVES THE MECHANISM, NOT THE RACE. Two real processes on a
 * barrier is the obvious test and it is not a gate: the window is the one or
 * two syscalls between a link and the readdir after it, and across 120 trials
 * with the doorway deliberately disabled it never once reproduced here, so it
 * would have certified the broken build as green. A test that cannot fail is
 * worse than no test, because it is counted. Planting a door by hand and
 * asserting that acquisition waits for it is deterministic, and it fails the
 * moment `doorBlocks` stops blocking.
 */
const DOOR_PROBE_SRC = `
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
const [lockSrc, lockPath, enteredPath] = process.argv.slice(2);
const { withFileLock } = await import(pathToFileURL(lockSrc).href);
withFileLock(lockPath, () => { writeFileSync(enteredPath, 'in'); });
`;

describe('a claimant inside its doorway', () => {
  it(
    'holds every other claimant out until it has published, then lets them in',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'tacendum-door-'));
      const script = join(dir, 'probe.mts');
      writeFileSync(script, DOOR_PROBE_SRC, { mode: 0o600 });
      const lockPath = join(dir, 'ratchet.lock');
      mkdirSync(lockPath, { recursive: true, mode: 0o700 });

      // A door belonging to a process that is unquestionably alive — this one.
      // The two-part `pid:hex` token is the legacy form lock.ts still honours,
      // which keeps this test independent of how an incarnation is spelled on
      // the host it runs on.
      const door = join(lockPath, `.door.${'ab12cd34'.repeat(4)}`);
      writeFileSync(door, `${process.pid}:deadbeef`, { mode: 0o600 });

      const entered = join(dir, 'entered');
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', script, join(process.cwd(), 'packages/cli/src/lock.ts'), lockPath, entered],
        {
          cwd: process.cwd(), // bare 'tsx' resolves from the repo root
          env: { ...process.env, NODE_USE_SYSTEM_CA: '0' },
          stdio: ['ignore', 'ignore', 'pipe'],
        },
      );
      let stderr = '';
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      const exited = new Promise<number | null>(resolve => child.on('exit', c => resolve(c)));

      try {
        // Long enough that a claimant which ignores doors has finished many
        // times over: acquisition is a handful of syscalls.
        await new Promise(r => setTimeout(r, 1_500));
        expect(
          existsSync(entered),
          'a claimant entered the lock while another was still inside its doorway — ' +
            'it read a queue that was not yet complete',
        ).toBe(false);

        rmSync(door, { force: true }); // the doorway closes
        await vi.waitFor(
          () => {
            if (!existsSync(entered)) {
              throw new Error(`never entered after the door closed: ${stderr.slice(0, 300)}`);
            }
          },
          { timeout: 15_000, interval: 20 },
        );
        expect(await exited, `probe exited badly: ${stderr.slice(0, 300)}`).toBe(0);
      } finally {
        child.kill('SIGKILL');
        rmSync(dir, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
