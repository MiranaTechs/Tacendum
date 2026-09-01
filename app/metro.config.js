const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const exclusionList = require('metro-config/private/defaults/exclusionList').default;

const workspaceRoot = path.resolve(__dirname, '..');

/**
 * Metro configuration for the pnpm monorepo (nodeLinker: hoisted).
 * watchFolders lets Metro see @tacendum/shared and the hoisted root
 * node_modules; nodeModulesPaths resolves modules from either location.
 * Metro runs on port 8083 — the local WS adapter owns 8081.
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {
  watchFolders: [workspaceRoot],
  resolver: {
    // .worktrees/*/node_modules under watchFolders storms Watchman recrawls (dev-only Fast Refresh red-box); exclusionList keeps the default __tests__ block.
    blockList: exclusionList([/\.worktrees\/.*/]),
    nodeModulesPaths: [
      path.resolve(__dirname, 'node_modules'),
      path.resolve(workspaceRoot, 'node_modules'),
    ],
    // @tacendum/shared uses NodeNext-style relative imports ('./tables.js')
    // that actually resolve to .ts sources; Metro takes the specifier
    // literally, so retry without the .js suffix.
    resolveRequest: (context, moduleName, platform) => {
      if (/^\.\.?\//.test(moduleName) && moduleName.endsWith('.js')) {
        try {
          return context.resolveRequest(context, moduleName.slice(0, -3), platform);
        } catch {
          // fall through to the literal specifier
        }
      }
      return context.resolveRequest(context, moduleName, platform);
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
