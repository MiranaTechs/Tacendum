import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Endpoints and store locations.
 *
 * PRODUCTION IS STILL THE DEFAULT — for an INSTALLED copy. The original
 * rationale stands: the first run of a tool someone `npm i -g`'d must not die
 * with connection-refused against a localhost port nothing listens on, and a
 * test run misconfigured to production fails loudly on an unknown account
 * while a release pointed at a dev server fails silently.
 *
 * What that rationale got wrong is the PUBLIC CHECKOUT. The README says "run
 * it locally", and with production-as-default a contributor who forgets one
 * export is talking to the live service — which actually happened here
 * once: a test suite made four unauthenticated POSTs to
 * api.tacendum.com believing it was on localhost. Three fixes, layered:
 *
 *  1. TACENDUM_ENV selects a named endpoint SET ('local' | 'aws'), so "point
 *     everything at the dev server" is one variable, not two urls to keep in
 *     sync. An unknown value throws at import — falling through to
 *     production on a typo is exactly the silent failure this exists to end.
 *  2. A checkout's root `.env` is loaded (below), so the choice lives in the
 *     one gitignored file contributors already create from `.env.example`
 *     (which ships TACENDUM_ENV=local) — set once, not re-exported per shell.
 *  3. One line to stderr names the resolved host on startup (below). Every
 *     incident of this class was a silence problem; whatever else goes
 *     wrong, the target is now in the transcript.
 *
 * TACENDUM_API / TACENDUM_WS still override individually and win over
 * TACENDUM_ENV — the two gates, `scripts/e2e.sh` and `scripts/app-verify.sh`
 * all export them explicitly and must keep beating everything else. An
 * EMPTY string means "unset" for all three: `process.loadEnvFile` will not
 * overwrite a set-but-empty variable (verified on node 22.21.1), so
 * `TACENDUM_ENV= tacendum …` is the shell idiom that forces the built-in
 * default past whatever a `.env` says — the offline gate needs exactly that.
 *
 * Hosts mirror `app/src/config.ts` (custom domains, verified live
 * 2026-07-26). No trailing slash on the API: `api.ts` builds
 * `${API_BASE}${path}`. No stage path on the socket: `wsclient.ts` appends
 * `?token=`.
 */
const ENDPOINTS = {
  local: { api: 'http://localhost:8080', ws: 'ws://localhost:8081/ws' },
  aws: { api: 'https://api.tacendum.com', ws: 'wss://ws.tacendum.com' },
} as const;

/**
 * The only keys the CLI is allowed to import from a checkout's `.env`. The
 * file also carries CDK deployment identifiers (hosted zone id, TURN ARNs),
 * and an unfiltered load would smuggle those into this process's env — which
 * is not hypothetical: vitest reuses forked workers across test files, and
 * `infra/lib/deployment-config.ts` falls back to `process.env`, so a CLI
 * test importing this module could silently reconfigure an infra test that
 * happens to share its worker.
 */
const DOTENV_KEYS = ['TACENDUM_ENV', 'TACENDUM_API', 'TACENDUM_WS'] as const;

/**
 * The root package.json `name` of THIS repository — the identity a candidate
 * root must prove before its `.env` is loaded. A marker no other project
 * carries by construction, unlike the structural ones below.
 */
const ROOT_PACKAGE_NAME = 'tacendum';

/**
 * True only when `dir` is the Tacendum checkout that this very module is
 * running FROM. The first version of this check accepted any directory with
 * `pnpm-workspace.yaml` + `packages/cli` — both are common furniture, and
 * this was reproduced: an installed
 * `@tacendum/cli` under a foreign pnpm monorepo that had both, loading that
 * stranger's `.env`. Three checks close it, each catching a shape the others
 * miss:
 *  1. this module must live under the candidate's OWN `packages/cli` — an
 *     installed copy lives under `node_modules/@tacendum/cli` and fails this
 *     even when the host repo has a `packages/cli` of its own;
 *  2. no `node_modules` segment between the candidate root and this module —
 *     an install nested INSIDE the host's `packages/cli` (e.g.
 *     `packages/cli/node_modules/@tacendum/cli`) passes check 1 lexically;
 *  3. the root package.json must be named `tacendum` — the only marker that
 *     is ours rather than merely workspace-shaped. Not sufficient alone (a
 *     Tacendum checkout can be VENDORED into someone's tree and its own
 *     `.env` is then still the right file — which is why the walk anchors on
 *     the executing module, not on the name).
 */
function isOwnCheckoutRoot(dir: string, moduleDir: string): boolean {
  if (!existsSync(join(dir, 'pnpm-workspace.yaml'))) return false;
  const relFromCli = relative(join(dir, 'packages', 'cli'), moduleDir);
  if (relFromCli.split(sep)[0] === '..' || isAbsolute(relFromCli)) return false;
  if (relative(dir, moduleDir).split(sep).includes('node_modules')) return false;
  try {
    const pkg = JSON.parse(
      readFileSync(join(dir, 'package.json'), 'utf8'),
    ) as { name?: unknown };
    return pkg.name === ROOT_PACKAGE_NAME;
  } catch {
    return false; // no root package.json, or unparseable — not our checkout
  }
}

/**
 * Find `<repo-root>/.env` by walking up from `startDir` (the directory this
 * module executes from). A directory counts as the repo root only if it
 * passes `isOwnCheckoutRoot` above. Installed copies therefore never load
 * any env file, which is the point: the checkout convenience must not become
 * installed-tool behavior. A near-miss (workspace file but failing identity)
 * does not stop the walk — for an installed copy the walk simply runs out of
 * parents and returns null.
 */
export function findRepoEnvFile(startDir: string): string | null {
  for (let dir = startDir; ; ) {
    if (isOwnCheckoutRoot(dir, startDir)) {
      const envPath = join(dir, '.env');
      return existsSync(envPath) ? envPath : null;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Load an env file via node's built-in `process.loadEnvFile` (no dotenv
 * dependency), then delete any key it added that is not in DOTENV_KEYS.
 * Variables already set in the environment win over the file — that is
 * loadEnvFile's own semantics (verified: a set variable, even empty, is
 * never overwritten), so an explicit `export TACENDUM_API=…` still beats
 * the checkout's `.env`. Absent file is a no-op, not an error.
 */
export function loadEnvFileIfPresent(path: string | null): void {
  if (path === null) return;
  const before = new Set(Object.keys(process.env));
  try {
    process.loadEnvFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const key of Object.keys(process.env)) {
    if (!before.has(key) && !(DOTENV_KEYS as readonly string[]).includes(key)) {
      delete process.env[key];
    }
  }
}

/** Resolved endpoints plus where they came from, for the startup line. */
export interface ResolvedEndpoints {
  api: string;
  ws: string;
  /** 'local' | 'aws' | 'override' — how API_BASE was chosen. */
  source: string;
}

/**
 * Pure resolution — exported so the matrix is testable without reloading
 * the module. Precedence: TACENDUM_API/TACENDUM_WS beat TACENDUM_ENV beats
 * the built-in production default. Unknown TACENDUM_ENV throws.
 */
export function resolveEndpoints(
  env: Record<string, string | undefined>,
): ResolvedEndpoints {
  const name = env.TACENDUM_ENV || undefined; // '' means unset — see header.
  let set: (typeof ENDPOINTS)[keyof typeof ENDPOINTS];
  if (name === undefined) {
    set = ENDPOINTS.aws;
  } else if (name === 'local' || name === 'aws') {
    set = ENDPOINTS[name];
  } else {
    throw new Error(
      `TACENDUM_ENV=${JSON.stringify(name)} names no known environment ` +
        `(expected "local" or "aws"); refusing to guess — the fallback ` +
        `would be production`,
    );
  }
  const api = env.TACENDUM_API || undefined;
  const ws = env.TACENDUM_WS || undefined;
  return {
    api: api ?? set.api,
    ws: ws ?? set.ws,
    source: api !== undefined ? 'override' : (name ?? 'aws'),
  };
}

loadEnvFileIfPresent(findRepoEnvFile(dirname(fileURLToPath(import.meta.url))));
const resolved = resolveEndpoints(process.env);

export const API_BASE = resolved.api;
export const WS_URL = resolved.ws;

// The one place a target announcement cannot be forgotten: every network
// entry point (`api.ts`, `wsclient.ts`) imports this module, so this line
// precedes the first request of any process. Stderr, because stdout belongs
// to --json consumers and the MCP transport.
{
  let host: string;
  try {
    host = new URL(API_BASE).host;
  } catch {
    host = API_BASE; // an override too mangled for URL() should still be shown
  }
  process.stderr.write(`tacendum: api ${host} (${resolved.source})\n`);
}

/** Root under which each client keeps its stores: `$TACENDUM_HOME/<name>/`. */
export function tacendumHome(): string {
  return process.env.TACENDUM_HOME ?? join(homedir(), '.tacendum');
}

function checkedName(name: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(name)) {
    // THE REJECTED NAME IS NOT ECHOED. Found by harness.canary.test.ts: a
    // misconfigured variable — `tacendum listen "$SECRET"` — reaches here,
    // and an over-long secret fails the length bound and was printed back in
    // full to stderr, i.e. into hook and CI logs. Describing
    // the RULE is as diagnosable as quoting the violation and cannot leak.
    throw new Error(
      'invalid client name — use 1-32 characters of letters, digits, "_" or "-", ' +
        'starting with a letter or digit',
    );
  }
  return name;
}

export function clientDir(name: string): string {
  return join(tacendumHome(), checkedName(name));
}

/**
 * Where DECRYPTED CHAT STATE lives — deliberately NOT `clientDir`.
 *
 * `$TACENDUM_HOME/<name>/` is the protocol compartment: the identity key,
 * the ratchet sessions, the pinned peer keys. The message log is a different
 * kind of thing — chat history — and the app keeps those two apart on
 * purpose, because tooling that copies "the key directory" (backups, `scp`
 * of a credential dir, a debug tarball attached to a ticket) should never
 * be silently copying a month of plaintext conversation along with it. Security
 * review made collapsing that compartment a defect, so the split is
 * structural: history under `state/`, keys where
 * they always were, and either can be wiped or excluded from sync without
 * touching the other.
 */
export function stateDir(name: string): string {
  return join(tacendumHome(), 'state', checkedName(name));
}
