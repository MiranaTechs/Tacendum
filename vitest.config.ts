import { mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

// NO TEST MAY WRITE THE DEVELOPER'S REAL HOME. Sibling rule to the keychain
// pin below, learned the same way: `hostConfigPathFor`, `voiceTargetFor` and
// mcp-install all resolve targets under `homedir()`, and an in-process test
// that drives `cmdSetup` while injecting only SOME of the io seams sends the
// rest to the real `~/.claude` / `~/.codex` (this happened: a setup test
// planted a real skill file and appended a block to the developer's real
// AGENTS.md — recovered only because the merge machinery keeps backups).
// Node's homedir() honors $HOME on unix, so one env pin covers every
// consumer, in-process and spawned alike. Tests still inject targetPath for
// determinism; this is the backstop that makes the mistake unlandable.
const testHome = mkdtempSync(join(tmpdir(), 'tacendum-vitest-home-'));

// The two safety pins, hoisted so BOTH projects below carry the same object
// rather than two copies that drift apart. A project that loses either one
// does not fail — it quietly corrupts the developer's machine instead, which
// is exactly the kind of thing a copy-paste divergence hides.
//
// NO TEST MAY TOUCH THE DEVELOPER'S REAL OS KEYCHAIN. The CLI's identity
// reads route through keychain.ts, whose item coordinates are (service
// "tacendum", account <name>) — GLOBAL per OS user, not per TACENDUM_HOME. A
// spawned-CLI test that inherits the real PATH would otherwise WRITE real
// `security`/`secret-tool` items on migration, and an in-process test with a
// fresh temp home would then READ them back and adopt a foreign credential
// under a colliding account name like "bot" (this happened: one planted item
// failed 23 tests in five files). `file` is keychain.ts's sanctioned "never
// touch a keychain" override; keychain.test.ts overrides or deletes this
// per-test under PATH shims, which is the one sanctioned way to test the real
// backends.
// DOCKER_CONFIG is the price of the HOME pin, and it is not optional. The
// docker CLI resolves its active context out of $HOME/.docker; with HOME
// moved to an empty temp dir every `docker compose exec` in a test exits
// 125. turn.integration.test.ts treats that failure as "no local coturn"
// and SKIPS — so the TURN credential math silently stopped being verified,
// and the run counted the file as passed. Found when a deny-list change
// broke the relay and no test noticed. Resolved here, where homedir() is
// still the developer's real home (this config is evaluated before the pin
// below reaches any worker).
const realDockerConfig = join(homedir(), '.docker');
const testEnv = {
  TACENDUM_CREDENTIAL_STORE: 'file',
  HOME: testHome,
  DOCKER_CONFIG: realDockerConfig,
};

const include = ['packages/**/*.{test,spec}.ts'];

const exclude = [
  '**/node_modules/**',
  '**/dist/**',
  'app/**',
  '**/cdk.out/**',
  // The invariant harnesses are run separately from the unit suite — they
  // are not skipped, they are separated.
  //
  // They are a different kind of test and they cost like one: dozens of
  // real child processes, a byte-offset sweep that rewrites a spool
  // hundreds of times, permission-flipping across a nine-by-eight failure
  // matrix. Run alongside the unit suite they saturate CPU and disk and
  // starve the timing-sensitive tests around them — a prekey-atomicity
  // integration test timed out at 30s purely from the company it was
  // keeping. A suite that fails for reasons unrelated to the code under
  // test is the thing that teaches people to re-run until green, which is
  // how a real failure gets waved through.
  '**/harness.*.test.ts',
];

/**
 * THE EXPENSIVE SUITES — the same judgement that separated the harnesses,
 * applied one level down.
 *
 * The harnesses were pulled out of the unit suite because they starved the
 * tests around them. They were not the only files doing it. Three consecutive
 * full runs of the remaining suite went red three DIFFERENT ways — 3 files,
 * then 8, then 9 — with almost no overlap between the sets, and every single
 * failure passed when its file was run alone. The failures were timeouts, not
 * assertions: a prekey rotation test that needs 15s of CPU got 15s of a
 * sixteenth of the CPU. That is not a test suite, it is a coin flip, and a
 * coin flip teaches people to re-run until green — which is how a real failure
 * gets waved through.
 *
 * Three groups of files do the starving, for three unrelated reasons:
 *
 *   1. DynamoDB Local is ONE Java process on :8000. Every test here queues
 *      behind the same server, so running them sixteen-wide does not make
 *      them faster — it makes each one's round trips slower and their
 *      timeouts tighter. Note what is and is not on this list: the
 *      `.integration.` suffix is NOT the signal. crew, crew.ws,
 *      auth-account and wsticket.datalayer drive the REAL db under ordinary
 *      names, and three of them were in the failure sets. Classify by what a
 *      file touches, not by what it is called.
 *
 *   3. The CLI suites that prove behaviour of the real binary spawn
 *      `node --import tsx packages/cli/src/main.ts` — a full TypeScript
 *      compile of the CLI, per child, several children per test. They are the
 *      single biggest source of load in the run, and they are the reason the
 *      files in group 1 and 2 time out.
 *
 *   4. One file is here for a fourth reason, and it is the one that actually
 *      went red: gate.prekeys writes 5 000 real files and then scans the
 *      directory. That cost is DISK, not CPU, so unlike everything else on
 *      this list it does not get better when the machine is less busy with
 *      arithmetic — measured, its worst test runs in 0.5s alone and 12.3s
 *      sharing a disk with three other workers. Against the fast project's
 *      15s that is not a margin, it is the next flake. Here it has 60s.
 *
 * Everything else — the pure unit tests — stays at full width,
 * because it is fast and it does not contend. The lock suites left behind
 * look alarming at ~10s per test and are not: that 10s is a deliberate wait
 * on a live lock holder, and it measures 10 014ms alone against 10 089ms
 * under load. A cost that does not move under contention cannot flake.
 */
const heavy = [
  // 1. Talks to DynamoDB Local (localhost:8000), a single Java process.
  'packages/server/test/*.integration.test.ts',
  'packages/server/test/accounts-group.test.ts',
  'packages/server/test/accounts-link.test.ts',
  'packages/server/test/accounts-revoke-teardown.test.ts',
  'packages/server/test/accounts-flag-gate.test.ts',
  'packages/server/test/accounts-roster.test.ts',
  'packages/server/test/accounts-quota-group.test.ts',
  'packages/server/test/accounts-identifier.test.ts',
  'packages/server/test/accounts-recovery.test.ts',
  'packages/server/test/accounts-discovery.test.ts',
  'packages/server/test/accounts-discovery-budget.test.ts',
  'packages/server/test/accounts-discovery-timing.test.ts',
  // The phone twins of the two lines above — same real store, and the
  // budget file additionally creates a per-run rate table and spends a
  // 2,000-take fleet window against it: it ran 4s alone in the fast project
  // and 25s under a full-suite run, which is the exact illusion this split
  // exists to end (classify by what a file touches).
  'packages/server/test/accounts-phone-discovery.test.ts',
  'packages/server/test/accounts-phone-discovery-budget.test.ts',
  // The rest of the phone suites, and the self-lookup discovery
  // suite. Each opens ListTables against :8000 in beforeAll and drives the
  // routes against the REAL store; accounts-phone additionally pages a full
  // Scan of two tables for its "nothing survives anywhere" dump grep, which
  // timed out at this project's 15s against a fat local store. None of these
  // was ever fast — they were merely unlisted, which the split's own rule
  // (classify by what a file touches) forbids.
  //
  // MOVING A FILE HERE TAKES IT OUT OF CI. The `check` job runs exactly one vitest
  // command — `vitest run --project fast` — and nothing anywhere runs `--project
  // heavy`, so a file listed here runs on a developer's machine and nowhere else.
  // Each of the three below carried store-blind pins that had been running on
  // every PR (byte vectors, wire-compat replays, the memory twin); the
  // reclassification silently dropped them, and the fix was to SPLIT rather than
  // to un-classify. The store-blind halves now live in fast
  // siblings — accounts-phone.pins.test.ts, accounts-phone-recovery.wire.test.ts,
  // and accounts-discovery-self.twin.test.ts (over the shared
  // accounts-discovery-self.suite.ts) — and must stay there. Before adding a file
  // to this list, check what CI stops running.
  'packages/server/test/accounts-phone.test.ts',
  'packages/server/test/accounts-phone-recovery.test.ts',
  'packages/server/test/accounts-discovery-self.test.ts',
  'packages/server/test/accounts-agent-reach.test.ts',
  'packages/server/test/accounts-agent-supersede.test.ts',
  'packages/server/test/accounts-deletion-sweep.test.ts',
  'packages/server/test/accounts-downgrade.test.ts',
  // The username uniqueness suite: the same scenario list against the twin
  // AND the real store — dozens of TransactWrites per case, all queued
  // behind :8000.
  'packages/server/test/accounts-username-claims.test.ts',
  // The username routes suite: the same two-DataLayer shape, plus a per-run
  // rate table it spends a 2,000-take fleet window against.
  'packages/server/test/accounts-username-routes.test.ts',
  // The username lookup suite: the phone-discovery twin — the same real
  // store, the same two-DataLayer scenario list, claims and lookups queued
  // behind :8000.
  'packages/server/test/accounts-username-discovery.test.ts',
  'packages/server/test/auth-account.test.ts',
  'packages/server/test/crew.test.ts',
  'packages/server/test/crew.ws.test.ts',
  'packages/server/test/wsticket.datalayer.test.ts',

  // 3. Spawns the real CLI as a child process (`node --import tsx main.ts`).
  'packages/cli/test/attend.test.ts',
  'packages/cli/test/crew.test.ts',
  'packages/cli/test/gate.binding-survives-refusal.test.ts',
  // Never appeared in a red run, and here anyway, because the rule above is
  // "classify by what a file touches", not "classify by what has been
  // caught". lock5 shims execFileSync but passes through to the real one, so
  // its children are real processes like the rest of this group.
  'packages/cli/test/gate.lock5.test.ts',
  // Live accept/decline against the INSTALLED codex binary (two real model
  // turns through `codex app-server`) — the version-skew check. Minutes,
  // not seconds, and a real child the fast project's cap could never hold;
  // its per-test timeouts override this project's 60s.
  'packages/cli/test/gate.codex-appserver.test.ts',
  // Same shape for the Agent SDK: a live canUseTool allow/deny through the
  // REAL Agent SDK, which spawns the operator's claude binary in-process —
  // real children and real model turns when its preconditions hold, a loud
  // skip when they do not; its per-test timeouts override this project's 60s.
  'packages/cli/test/gate.claude-sdk.test.ts',
  // Same shape for steering: a live steer through a real `codex app-server`
  // child, plus the wrong-id arm — the steer half of the version-skew check.
  'packages/cli/test/gate.steer-live.test.ts',
  'packages/cli/test/gate.credential-echo.test.ts',
  'packages/cli/test/gate.failed-read-not-absence.test.ts',
  'packages/cli/test/gate.gc3-serialized-redaction.test.ts',
  'packages/cli/test/gate.gc3-state-shape.test.ts',
  'packages/cli/test/gate.lock.test.ts',
  'packages/cli/test/gate.main-mcp.test.ts',
  // The one the first classification missed:
  // spawns `node --import tsx main.ts` four times across two tests AND stands
  // up a real node:http server at module scope. It ran 1.9s alone in the fast
  // project — a margin that exists only until the machine is busy, which is
  // the exact illusion this split exists to end.
  'packages/cli/test/gate.owner-inheritance-race.test.ts',
  'packages/cli/test/gate.register-lock.test.ts',
  'packages/cli/test/gate.registry-coverage.test.ts',
  'packages/cli/test/gate.remedy-resolver.test.ts',
  'packages/cli/test/gate.remedy-truth.test.ts',
  'packages/cli/test/gate.server-line-forgery.test.ts',
  'packages/cli/test/gate.session-argv.test.ts',
  'packages/cli/test/gate.session.test.ts',
  'packages/cli/test/gate.stored-token-leak.test.ts',
  'packages/cli/test/gate.structured-credential.test.ts',
  'packages/cli/test/gate.unit-program-registered.test.ts',
  'packages/cli/test/gate.unreadable-profile.test.ts',
  'packages/cli/test/gate.value-redaction.test.ts',
  // The `inbox --detail` surface test: it asserts on the REAL CLI's stdout,
  // so every case is another `node --import tsx main.ts` child.
  'packages/cli/test/inbox.rounds.test.ts',
  'packages/cli/test/keychain.test.ts',
  'packages/cli/test/mcp.test.ts',
  'packages/cli/test/run.test.ts',
  // Not a CLI spawn — an esbuild bundle of the whole package, per test.
  'packages/cli/test/packaging.test.ts',

  // 4. Disk-bound: writes 5 000 real files, then scans the directory.
  'packages/cli/test/gate.prekeys.test.ts',
];

export default defineConfig({
  test: {
    // ONE FORK PER ~4 CORES, NOT ONE PER CORE. Vitest defaults maxForks to
    // `cpus - 1` (15 here) on the assumption that a worker is worth about a
    // core. Nothing in this repo honours that assumption: the CLI suites
    // spawn `node --import tsx` children, packaging tests shell out to
    // esbuild, and the prekey suites drive libsignal's native crypto.
    // Fifteen workers is
    // therefore forty-odd real processes on sixteen cores, and the effect is
    // measured, not theoretical — `gate.prekeys`'s slowest test takes 525ms
    // with the machine to itself and 11.5s at the default width. It is the
    // test that timed out at 15s in two of the three red runs, and it did not
    // get slower; it got crowded.
    //
    // Four is the number that leaves headroom rather than the number that
    // finishes soonest, and that is the trade being made on purpose: a suite
    // whose verdict depends on how loaded the machine was is not a gate.
    // maxForks is a root option in vitest 3 — it cannot be set per project —
    // so it is set once here and both projects below inherit it.
    //
    // FOUR TO THREE, for the same reason one layer up. At four,
    // every full run ended `Tests 2272 passed (2272)` and then exited NON-ZERO
    // on an unhandled `[vitest-worker]: Timeout calling "onTaskUpdate"`. That
    // RPC is worker->main with birpc's 60s DEFAULT_TIMEOUT, and vitest 3.2
    // gives no way to raise it (createForksRpcOptions passes no `timeout`).
    // The starved process is the MAIN one: it serves every worker's transforms
    // while draining their task updates, and four workers that each fan out
    // into real subprocesses and native crypto can hold it past sixty seconds.
    // Contention, not a test - the two slowest files (~67s each) both exit 0
    // when run alone.
    //
    // Measured, whole suite, this machine:
    //   4 forks - 201s, unhandled RPC timeout, exit 1 (twice out of two)
    //   3 forks - 241s, clean, exit 0
    //   2 forks - 354s, clean, exit 0
    // `tests` also fell 727s -> 656s going 4 -> 3: the fourth worker was not
    // buying throughput, it was buying crowding - the same thing the 15 -> 4
    // note above found. Forty seconds of wall clock is the price of a suite
    // that reports its own verdict correctly, and a run that passes 2272 tests
    // and then exits 1 teaches people to read the exit code as noise.
    poolOptions: { forks: { maxForks: 3 } },
    projects: [
      {
        test: {
          name: 'fast',
          include,
          // The heavy files are excluded here rather than merely listed
          // there: a file matched by two projects is COLLECTED BY BOTH and
          // runs twice.
          exclude: [...exclude, ...heavy],
          env: testEnv,
          // Unchanged from before the split. The invariant this project
          // maintains — enforced by suite-classification.test.ts, not by
          // vigilance — is that nothing here imports node:child_process:
          // every file waits only on its own CPU, so at the width set above
          // 15s is a generous budget.
          testTimeout: 15_000,
          hookTimeout: 30_000,
        },
      },
      {
        test: {
          name: 'heavy',
          include: heavy,
          exclude,
          env: testEnv,
          // The DDB suites create and wait on real tables in their
          // beforeAll hooks.
          testTimeout: 60_000,
          hookTimeout: 180_000,
          // Run AFTER the fast project, never alongside it. This is what
          // makes the split worth having: the suites that queue behind one
          // DynamoDB Local process are kept away from the CPU-bound
          // unit tests instead of being interleaved with them. (Counts are
          // deliberately not written here — an earlier draft pinned "twelve"
          // and "thirteen" and both had drifted before they were ever read.)
          // Groups run lowest-first, and a group does not start until the
          // previous one has finished.
          //
          // Deliberately NOT `poolOptions.forks.singleFork` — the per-project
          // spelling of `fileParallelism: false`,
          // and the first thing tried here. It is slower AND worse: singleFork
          // hands the whole project to ONE worker as a single task, so all
          // fifty files share one module registry and one process. Measured,
          // that turned a 164s group into a 285s one and inflated the
          // CLI-spawning gates roughly tenfold (gate.structured-credential:
          // ~1.5s alone, 43s sharing a process). The harnesses can afford
          // that; fifty files carrying each other's leaked state cannot.
          sequence: { groupOrder: 1 },
          // The forks pool, deliberately, and it is not a preference: suites
          // that shell out to esbuild died under `--pool=threads` with
          // ERR_INVALID_ARG_VALUE — the bundling inherits the worker's
          // stdio, and a worker thread's stdio is not a real fd.
          pool: 'forks',
        },
      },
    ],
  },
});
