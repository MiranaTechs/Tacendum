/* eslint-env jest */
/**
 * Auto-unmount for react-test-renderer roots — the cleanup RTR does not do.
 *
 * The defect this closes: a test that walks away from a mounted tree leaves
 * the components' timers and subscriptions live past the file's last test —
 * VirtualizedList's 50ms cell batcher, ChatThreadScreen's 80ms refresh
 * debounce riding its messaging subscription. When one fires after the file
 * finished, the file's frozen console prints "Cannot log after tests are
 * done" — and jest-runner's freezeConsole also sets process.exitCode = 1
 * (jest-runner/build/runTest.js, fakeConsolePush). On a 2-vCPU CI runner
 * jest computes maxWorkers = 1 and runs in-band, so that exit code belongs
 * to the ONE jest process: 133 green suites, then exit 1, a red required
 * check with nothing red in it. On a wider machine the same write lands in a
 * worker whose exit code is discarded once its results are in — which is why
 * the leak read as harmless console noise here and a failed build there.
 * A leaked re-render can also outlive the module registry and throw
 * "You are trying to `import` a file after the Jest environment has been
 * torn down" out of react-native's lazy index getters (useWindowDimensions).
 *
 * Mechanics: track every root create() hands out; a root a test unmounts
 * itself is untracked by its wrapped unmount; whatever is still mounted when
 * the test ends is unmounted here, inside act(), while the file is still
 * alive — so the unmount cleanups actually run and clear those timers. This
 * afterEach registers before any suite's own hooks and therefore runs before
 * them (jest-circus runs same-block afterEach hooks in registration order),
 * i.e. before a suite's db.close()/restoreAllMocks teardown. Suites that
 * already unmount in their own afterEach (CallScreen's mounted[] pattern)
 * find their roots untracked here and unmount them again as a no-op —
 * react-test-renderer tolerates a second unmount.
 */

const ReactTestRenderer = require('react-test-renderer');

const mounted = new Set();
const realCreate = ReactTestRenderer.create;

ReactTestRenderer.create = function create(...args) {
  const root = realCreate.apply(this, args);
  mounted.add(root);
  const realUnmount = root.unmount;
  root.unmount = function unmount(...rest) {
    mounted.delete(root);
    return realUnmount.apply(this, rest);
  };
  return root;
};

afterEach(() => {
  if (mounted.size === 0) return;
  const leftovers = [...mounted];
  mounted.clear();
  ReactTestRenderer.act(() => {
    for (const root of leftovers) root.unmount();
  });
});
