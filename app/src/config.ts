/**
 * Backend endpoints.
 *
 * Release builds always talk to AWS — that is not configurable, so a
 * TestFlight or App Store binary can never ship pointed at a dev server.
 * `resolveTarget` returns 'aws' before ever looking at the raw value, so no
 * environment variable, .env file, or typo can influence a release build.
 *
 * Debug builds follow TACENDUM_ENV (shared with the CLI — one variable in
 * the repo-root .env points ALL the tooling at one backend), read at BUNDLE
 * time by react-native-dotenv in babel.config.js:
 *   'local' — the docker-compose dev server. Only resolves from the
 *             iOS simulator, which shares the host's loopback. This is what
 *             scripts/app-verify.sh expects.
 *   'aws'   — the deployed stack. Required to run a debug
 *             build on a physical device, where localhost is the phone.
 *   unset   — 'local'. This used to be a tracked-source constant that shipped
 *             pointing at 'aws', which meant every contributor's first debug
 *             build talked to PRODUCTION unless they edited source. The
 *             default must be the target that fails loudly (connection
 *             refused on a port nothing listens on) rather than the one that
 *             quietly creates real accounts; pointing a debug build at aws is
 *             now the deliberate act.
 *   other   — throw at bundle evaluation (redbox). Guessing 'aws' on a typo
 *             would resurrect the silent-production failure.
 *
 * Debug builds ALSO honour TACENDUM_API / TACENDUM_WS as individual endpoint
 * overrides that beat TACENDUM_ENV ('' means unset) — the same precedence the
 * CLI gives them (packages/cli/src/config.ts), because the README documents
 * one rule for both and an app that silently ignored the variables the e2e
 * gates export is exactly how this gate was once found pointed at
 * production. Release builds ignore these too: `resolveEndpoints` returns the
 * aws set before reading ANY raw value.
 *
 * Why `process.env.TACENDUM_ENV` and not the plugin's `import ... from
 * '@env'` module: bare RN 0.86 inlines only NODE_ENV (verified:
 * metro-transform-plugins/src/inline-plugin.js matches process.env.NODE_ENV
 * and nothing else), so BOTH spellings need the babel plugin — but the
 * '@env' virtual module needs an ambient type declaration and hard-crashes
 * at require time if the plugin is ever dropped from babel.config.js, while
 * this spelling degrades to a runtime lookup against Metro's process shim
 * (undefined → 'local', the safe target). The trade: the plugin only inlines
 * `process.env.X` for keys that appear in a .env FILE (react-native-dotenv
 * index.js builds `processEnvInlineKeys` from the parsed files — reverified
 * with a direct babel transform), so a shell-only export with no
 * .env key at all is ignored — that failure also lands on 'local' and is
 * visible in Metro's "injected env" line, never on production. With the key
 * present in a .env, a NON-EMPTY shell export overrides the file's value
 * (an empty one does not — the plugin drops falsy shell values, so the
 * bundle-time idiom differs from the CLI's `TACENDUM_ENV=` there). This is
 * why `.env.example` ships TACENDUM_API=/TACENDUM_WS= as empty keys: the
 * key's PRESENCE is what makes a shell export reachable. scripts/app-verify.sh
 * does not rely on any of that — it writes its own `.env.verify` mode file
 * and starts Metro with APP_ENV=verify, the one mechanism that wins no matter
 * what the operator's .env says, and then asserts the RUNNING app's resolved
 * endpoint over CDP before registering anything.
 *
 * Metro runs on 8083 (the WS adapter owns 8081).
 */
declare const __DEV__: boolean;
// Type-only, erased at compile: RN's tsconfig declares no `process` global
// (types: ["jest"]), but the value exists everywhere this runs — Metro's
// prelude defines `process.env`, Jest runs under node — and babel rewrites
// the whole expression to a literal whenever .env defines the key anyway.
declare const process: {
  env: { TACENDUM_ENV?: string; TACENDUM_API?: string; TACENDUM_WS?: string };
};

export const ENDPOINTS = {
  local: {
    api: 'http://localhost:8080',
    ws: 'ws://localhost:8081/ws',
  },
  aws: {
    // No trailing slash: api.ts builds `${API_BASE}${path}`. Custom domains
    // verified live (400/404/401 semantics through both); the raw
    // execute-api endpoints remain deployed as the rollback.
    api: 'https://api.tacendum.com',
    // Root mapping — no /prod stage path on the custom domain; ws.ts
    // appends `?token=`.
    ws: 'wss://ws.tacendum.com',
  },
} as const;

export type DevTarget = keyof typeof ENDPOINTS;

/**
 * Pure so the release/debug matrix is testable under Jest, where the raw
 * value is whatever babel already baked in and cannot be varied per test.
 * ORDER MATTERS: the `!dev` return comes first so release builds never
 * evaluate — and can never throw on — the environment-supplied value.
 */
export function resolveTarget(dev: boolean, raw: string | undefined): DevTarget {
  if (!dev) return 'aws';
  if (raw === undefined || raw === '' || raw === 'local') return 'local';
  if (raw === 'aws') return 'aws';
  throw new Error(
    `TACENDUM_ENV=${JSON.stringify(raw)} names no known target ` +
      `(expected "local" or "aws"); refusing to guess`,
  );
}

/**
 * Individual endpoint overrides, debug-only, same precedence as the CLI:
 * TACENDUM_API / TACENDUM_WS beat TACENDUM_ENV, '' means unset. Pure and
 * separate from `resolveTarget` so the release invariant stays provable in
 * one place: the `!dev` return comes FIRST, before any raw value is read,
 * so no environment variable of any kind can influence a release build —
 * not the target, not an endpoint, not even a throw on garbage.
 */
export function resolveEndpoints(
  dev: boolean,
  rawTarget: string | undefined,
  rawApi: string | undefined,
  rawWs: string | undefined,
): { api: string; ws: string } {
  if (!dev) return ENDPOINTS.aws;
  const set = ENDPOINTS[resolveTarget(dev, rawTarget)];
  return {
    api: rawApi !== undefined && rawApi !== '' ? rawApi : set.api,
    ws: rawWs !== undefined && rawWs !== '' ? rawWs : set.ws,
  };
}

/** Exported for the wiring assertion in __tests__/config.target.test.ts. */
export const IS_DEV: boolean = __DEV__;
export const RAW_DEV_TARGET: string | undefined = process.env.TACENDUM_ENV;
export const RAW_API_OVERRIDE: string | undefined = process.env.TACENDUM_API;
export const RAW_WS_OVERRIDE: string | undefined = process.env.TACENDUM_WS;
export const DEV_TARGET: DevTarget = resolveTarget(IS_DEV, RAW_DEV_TARGET);

const endpoints = resolveEndpoints(
  IS_DEV,
  RAW_DEV_TARGET,
  RAW_API_OVERRIDE,
  RAW_WS_OVERRIDE,
);

export const API_BASE: string = endpoints.api;
export const WS_URL: string = endpoints.ws;

/** Single-device build (matches the CLI). */
export const DEVICE_ID = 1;
