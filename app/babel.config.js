const { join } = require('path');

module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [
    // zod v4 ships `export * as ns from ...`, which Hermes/Metro needs
    // transformed explicitly.
    '@babel/plugin-transform-export-namespace-from',
    // Bakes the repo-root .env into the bundle at TRANSFORM time so a debug
    // build's backend target (src/config.ts) is chosen by the contributor's
    // gitignored .env, not by editing tracked source. A babel plugin and not
    // a shell export, because Metro's transform cache does not key on the
    // shell environment — an exported variable that changed after the first
    // build would go stale invisibly, which is the exact silent-wrong-target
    // failure this exists to end. The plugin registers the .env files' mtimes
    // with babel's cache (api.cache.using + addExternalDependency), so
    // editing .env rebuilds.
    //
    // The path is absolute because Metro runs with cwd app/ and Jest can run
    // from anywhere; `allowUndefined` because a checkout without a .env must
    // still build (config.ts then resolves to 'local', the safe target) —
    // the plugin's default `safe: false` would otherwise be fine too, but
    // spelled out so nobody "tightens" it into a build that requires a .env.
    //
    // The plugin also reads `<path>.<APP_ENV>` as a mode file whose values
    // beat the base .env (its mtime is cache-keyed and registered as an
    // external dependency, same as .env). scripts/app-verify.sh depends on
    // that: it writes `<root>/.env.verify` and starts Metro with
    // APP_ENV=verify, so the acceptance gate's target wins over whatever the
    // operator's .env says — the operator's file once said `aws` and the
    // gate was one registration away from creating accounts on production
    // (verified by direct transform). Do not remove the mode-file
    // behavior by pinning the plugin's env resolution.
    [
      'module:react-native-dotenv',
      {
        path: join(__dirname, '..', '.env'),
        allowUndefined: true,
      },
    ],
  ],
};
