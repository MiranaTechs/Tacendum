module.exports = {
  root: true,
  extends: '@react-native',
  // BUILD OUTPUT IS NOT SOURCE. `eslint .` walks everything under app/, and
  // since the Android tree landed that includes app/android/build — where
  // Gradle writes HTML reports with third-party JS bundled beside them (a
  // dependency-verification failure report ships uikit.min.js). Linting those
  // produced 34 `no-undef` errors about `window`-only globals and turned
  // app:lint red for a reason that had nothing to do with any source file.
  // Found 2026-08-18 at phase A4, the first phase whose Gradle runs emit such
  // a report; ignored here rather than in .gitignore because the files are
  // already untracked — being untracked is exactly why nobody noticed them.
  ignorePatterns: ['android/build/', 'android/.gradle/', 'android/.kotlin/'],
  rules: {
    // `void somePromise()` — and `onPress={() => void save()}` — is the house
    // idiom for a deliberate fire-and-forget: it satisfies void-return handler
    // types while marking the drop at the call site. The rule flags both the
    // statement and the expression form, so it is off rather than half-tuned.
    'no-void': 'off',
    // Styles here are computed from theme tokens at the call site by design —
    // the palette lives in theme.ts and the conditionals (pressed, focused,
    // narrow) are the design system working, not style-sheet omissions.
    'react-native/no-inline-styles': 'off',
  },
};
