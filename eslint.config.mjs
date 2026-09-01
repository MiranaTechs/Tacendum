import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      // CDK output directories drop bundled, minified vendor code that would
      // otherwise be linted as if we wrote it.
      '**/cdk.out*/**',
      '**/node_modules/**',
      // Other branches' working copies. A worktree is a checkout of a
      // different branch, so linting it reports that branch's problems as
      // this branch's — unfixable here, and fixed already or never for us.
      // It also drowns what is ours: 683 of 709 errors came from here, and
      // the 26 real ones were invisible underneath them.
      '.worktrees/**',
      'app/**',
      'coverage/**',
      '.remember/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        fetch: 'readonly',
        // A Node global since v10, and this repo requires >= 20. Its absence
        // here made `no-undef` report `new URL(..., import.meta.url)` — the
        // standard way a .mjs script resolves a path against itself — as a
        // typo. The rule was not wrong to be on; the runtime model was wrong.
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
