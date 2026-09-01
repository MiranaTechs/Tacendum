/**
 * Backend target selection (src/config.ts).
 *
 * DEV_TARGET used to be a tracked-source constant hardwired to 'aws', so
 * every contributor's debug build talked to production. These tests pin the
 * replacement's contract:
 *   - release builds are hard-wired to aws with NO env influence at all
 *     (not even a throw on garbage — the value is never read);
 *   - debug builds default to 'local', the target that fails loudly;
 *   - debug builds honour TACENDUM_ENV, and a typo throws instead of
 *     guessing.
 *
 * The matrix is exercised through `resolveTarget` rather than by varying the
 * environment, because react-native-dotenv inlines the raw value at BABEL
 * time — whatever the machine's .env said when Jest transformed the module —
 * so per-test env mutation cannot reach it and any assertion on the inlined
 * value would be machine-dependent. The wiring assertions below close the
 * loop instead: the module's exports must equal recomputing through
 * `resolveTarget` from the raw value the module actually saw.
 */
import {
  API_BASE,
  DEV_TARGET,
  ENDPOINTS,
  IS_DEV,
  RAW_API_OVERRIDE,
  RAW_DEV_TARGET,
  RAW_WS_OVERRIDE,
  WS_URL,
  resolveEndpoints,
  resolveTarget,
} from '../src/config';

// The same file-local declaration src/config.ts carries, for the same reason:
// the app's tsconfig lists only the jest types, so there is no ambient `process`
// here — but Jest runs under node, where the value exists. Optional properties
// because the override test below deletes and restores them.
declare const process: {
  env: { TACENDUM_API?: string; TACENDUM_WS?: string };
};

describe('release builds (dev=false)', () => {
  it('are aws no matter what the environment says', () => {
    expect(resolveTarget(false, undefined)).toBe('aws');
    expect(resolveTarget(false, '')).toBe('aws');
    expect(resolveTarget(false, 'local')).toBe('aws');
    expect(resolveTarget(false, 'aws')).toBe('aws');
  });

  it('do not even validate the value — garbage cannot crash a release', () => {
    expect(resolveTarget(false, 'produciton')).toBe('aws');
  });
});

describe('debug builds (dev=true)', () => {
  it('default to local — production requires a deliberate act', () => {
    expect(resolveTarget(true, undefined)).toBe('local');
    expect(resolveTarget(true, '')).toBe('local');
  });

  it('honour the override in both directions', () => {
    expect(resolveTarget(true, 'aws')).toBe('aws');
    expect(resolveTarget(true, 'local')).toBe('local');
  });

  it('throw on a typo instead of guessing a backend', () => {
    expect(() => resolveTarget(true, 'produciton')).toThrow(/produciton/);
    expect(() => resolveTarget(true, 'locl')).toThrow(/TACENDUM_ENV/);
  });
});

describe('resolveEndpoints — individual overrides', () => {
  // The app used to ignore TACENDUM_API/TACENDUM_WS entirely while the
  // README claimed they beat TACENDUM_ENV — which is exactly how
  // the device-verification harness ended up registering a simulator account against
  // production while its CLI peer talked to localhost. Debug builds now give
  // the two variables the same precedence the CLI does.
  it('release builds return aws without reading ANY raw value', () => {
    expect(
      resolveEndpoints(false, 'local', 'http://evil:1', 'ws://evil:2'),
    ).toEqual(ENDPOINTS.aws);
    // Garbage in every slot must not throw either — the values are never read.
    expect(resolveEndpoints(false, 'produciton', '', 'nonsense')).toEqual(
      ENDPOINTS.aws,
    );
  });

  it('debug: overrides beat TACENDUM_ENV, matching the CLI precedence', () => {
    expect(
      resolveEndpoints(true, 'aws', 'http://localhost:8080', 'ws://localhost:8081/ws'),
    ).toEqual({ api: 'http://localhost:8080', ws: 'ws://localhost:8081/ws' });
  });

  it('debug: each override is independent of the other', () => {
    expect(resolveEndpoints(true, 'local', 'http://127.0.0.1:9099', undefined)).toEqual({
      api: 'http://127.0.0.1:9099',
      ws: ENDPOINTS.local.ws,
    });
    expect(resolveEndpoints(true, 'local', undefined, 'ws://127.0.0.1:2323/ws')).toEqual({
      api: ENDPOINTS.local.api,
      ws: 'ws://127.0.0.1:2323/ws',
    });
  });

  it("debug: '' means unset, same as the CLI — the .env.example ships empty keys", () => {
    expect(resolveEndpoints(true, undefined, '', '')).toEqual(ENDPOINTS.local);
    expect(resolveEndpoints(true, 'aws', '', '')).toEqual(ENDPOINTS.aws);
  });

  it('debug with no overrides follows the target, including the typo throw', () => {
    expect(resolveEndpoints(true, undefined, undefined, undefined)).toEqual(
      ENDPOINTS.local,
    );
    expect(() => resolveEndpoints(true, 'produciton', undefined, undefined)).toThrow(
      /TACENDUM_ENV/,
    );
  });
});

describe('endpoint sets', () => {
  it('local matches what the device-verification harness starts', () => {
    expect(ENDPOINTS.local).toEqual({
      api: 'http://localhost:8080',
      ws: 'ws://localhost:8081/ws',
    });
  });

  it('aws matches the custom domains (mirrored in packages/cli/src/config.ts)', () => {
    expect(ENDPOINTS.aws).toEqual({
      api: 'https://api.tacendum.com',
      ws: 'wss://ws.tacendum.com',
    });
  });
});

describe('module wiring', () => {
  it('runs as a debug build under jest (the release path is the ternary, proven above)', () => {
    // @react-native/jest-preset sets global.__DEV__ = true; if this ever
    // flips, the wiring assertion below silently changes meaning — fail
    // here instead.
    expect(IS_DEV).toBe(true);
  });

  it('a live runtime override reaches API_BASE/WS_URL (fresh require)', () => {
    // When a key is NOT in this machine's .env, babel leaves the
    // `process.env.X` lookup live (proven by direct transform) —
    // so setting it here and re-requiring exercises the real module wiring,
    // not just the pure function. On a machine whose .env DOES define a
    // truthy TACENDUM_API, the inlined literal wins and this collapses into
    // the same recompute assertion as above — still valid, just weaker.
    const saved = {
      api: process.env.TACENDUM_API,
      ws: process.env.TACENDUM_WS,
    };
    process.env.TACENDUM_API = 'http://127.0.0.1:19099';
    process.env.TACENDUM_WS = 'ws://127.0.0.1:19098/ws';
    jest.resetModules();
    try {
      const fresh = require('../src/config') as typeof import('../src/config');
      const expected = fresh.resolveEndpoints(
        fresh.IS_DEV,
        fresh.RAW_DEV_TARGET,
        fresh.RAW_API_OVERRIDE,
        fresh.RAW_WS_OVERRIDE,
      );
      expect(fresh.API_BASE).toBe(expected.api);
      expect(fresh.WS_URL).toBe(expected.ws);
      // Non-vacuity: if the lookup was live (raw export equals what we set),
      // the override MUST have landed in API_BASE.
      if (fresh.RAW_API_OVERRIDE === 'http://127.0.0.1:19099') {
        expect(fresh.API_BASE).toBe('http://127.0.0.1:19099');
      }
    } finally {
      if (saved.api === undefined) delete process.env.TACENDUM_API;
      else process.env.TACENDUM_API = saved.api;
      if (saved.ws === undefined) delete process.env.TACENDUM_WS;
      else process.env.TACENDUM_WS = saved.ws;
      jest.resetModules();
    }
  });

  it('exports exactly what the resolvers say for the values babel baked in', () => {
    expect(DEV_TARGET).toBe(resolveTarget(IS_DEV, RAW_DEV_TARGET));
    // API_BASE/WS_URL must come through resolveEndpoints — recomputed from
    // the raw values the module actually saw, because what babel inlined is
    // whatever this machine's .env said at transform time.
    const expected = resolveEndpoints(
      IS_DEV,
      RAW_DEV_TARGET,
      RAW_API_OVERRIDE,
      RAW_WS_OVERRIDE,
    );
    expect(API_BASE).toBe(expected.api);
    expect(WS_URL).toBe(expected.ws);
  });
});
