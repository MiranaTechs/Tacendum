/**
 * A node test environment that carries the REAL `@signalapp/libsignal-client`
 * into the sandbox (see jest.libsignal.js for why the sandbox cannot load it
 * itself: the package is pure ESM + a native binding, and jest's CJS runtime
 * intercepts even `createRequire`, so the escape hatch must live HERE —
 * environment modules are loaded by the worker's real Node loader, outside
 * the sandbox, where `require(esm)` works).
 *
 * Selected per suite with a `@jest-environment ./jest.env.libsignal.js`
 * docblock (link-vectors.test.ts); every other suite keeps the preset's
 * default environment and never pays the native load.
 */
/* eslint-env node */
'use strict';

const { TestEnvironment } = require('jest-environment-node');
const { createRequire } = require('node:module');

class LibsignalEnvironment extends TestEnvironment {
  async setup() {
    await super.setup();
    // Node's own require — ≥22.12 loads the ESM graph and the prebuilt
    // .node synchronously. The namespace object crosses into the sandbox as
    // a real-realm object; libsignal's native glue type-checks its byte
    // arguments at the V8 level, which is realm-independent.
    this.global.__LIBSIGNAL_NATIVE__ = createRequire(__filename)(
      '@signalapp/libsignal-client',
    );
  }
}

module.exports = LibsignalEnvironment;
