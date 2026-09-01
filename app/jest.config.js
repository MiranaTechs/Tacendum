module.exports = {
  preset: '@react-native/jest-preset',
  setupFiles: ['<rootDir>/jest.setup.js'],
  // Auto-unmount of react-test-renderer roots (see that file for the CI
  // exit-1 mechanism a leaked tree's timers trip). After-env, not setup:
  // it registers an afterEach, which only exists once the framework is up.
  setupFilesAfterEnv: ['<rootDir>/jest.setup.after.js'],
  // react-native-image-picker and the safe-area-context jest mock ship
  // untranspiled ESM/TSX; let Babel transform them (the preset's default
  // ignore pattern only whitelists react-native itself).
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|react-native-image-picker|react-native-safe-area-context)/)',
  ],
  // NEVER COLLECT FROM A GIT WORKTREE. `.worktrees/` holds other branches'
  // full checkouts, each with its own copy of this app's ~120 test files. Run
  // from the repo root, jest walks them and reports another branch's failures
  // as this branch's — and reports them from paths that look almost right,
  // which is how twenty minutes went into debugging a "failure" that was
  // another branch's in-progress work. rootDir is `app/`, so the
  // pattern reaches up: the copies live at `<repo>/.worktrees/<name>/app/`.
  //
  // The root vitest config carries the same guard for the same reason, and
  // eslint gained one on the same day. Three tools, one hazard.
  testPathIgnorePatterns: ['/node_modules/', '/\\.worktrees/'],
  moduleNameMapper: {
    // @tacendum/shared uses NodeNext-style './x.js' specifiers for .ts sources
    // (same shim as metro.config.js resolveRequest).
    '^(\\.{1,2}/.*)\\.js$': '$1',
    // The REAL libsignal, through Node's own require(esm) — the package is
    // pure ESM and jest's CJS runtime cannot compile it, but the link-vectors
    // suite must run the server's genuine verify path (see jest.libsignal.js
    // for the whole argument; a loader shim, never a mock).
    '^@signalapp/libsignal-client$': '<rootDir>/jest.libsignal.js',
  },
};
