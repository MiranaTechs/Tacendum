/**
 * Loader shim, not a mock: `@signalapp/libsignal-client` ships pure ESM
 * (`import.meta.dirname` reaches its native binding), which jest's CJS
 * sandbox cannot compile — and the sandbox intercepts `createRequire` too,
 * so no code RUNNING IN a test can reach Node's own loader. The genuine
 * module is therefore loaded by the test ENVIRONMENT (jest.env.libsignal.js,
 * which jest executes in the worker's real Node realm) and picked up here.
 *
 * Exists for exactly one consumer: app/__tests__/link-vectors.test.ts
 * imports the SERVER's `verifyIdentitySignature`
 * (packages/server/src/handlers/identity-verify.ts), whose libsignal import
 * the jest.config.js moduleNameMapper points here. Every symbol is the
 * genuine library's — nothing is re-implemented, which is the whole point of
 * the cross-language vector suite riding the server's verify path.
 */
/* eslint-env node */
/* global globalThis */
'use strict';

if (!globalThis.__LIBSIGNAL_NATIVE__) {
  throw new Error(
    'this suite needs the real libsignal: add a ' +
      '@jest-environment ./jest.env.libsignal.js docblock (see jest.libsignal.js)',
  );
}
module.exports = globalThis.__LIBSIGNAL_NATIVE__;
