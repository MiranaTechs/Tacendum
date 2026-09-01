/**
 * The WindowClass provider + pane-width context.
 *
 * Nothing consumes these yet — a sweep greps screens for the absence.
 * This suite pins the shell facts the later phases build on: the Material
 * cuts live in the token system at 600/840 with the pane bounds beside them;
 * classification answers 599/600/839/840 correctly and is width-driven
 * (rotation reclassifies by the new width, nothing else); compact is the
 * providerless default at ANY width (the theme light-default discipline);
 * pane width is a distinct fact from window width that coincides with it in
 * compact; and the re-render contract holds — a resize within a class leaves
 * useWindowClass consumers alone, a boundary crossing re-renders them.
 *
 * Dimensions are driven through the real Dimensions emitter (the same path a
 * device rotation takes), never by mocking the hook: the jest preset boots
 * the window at 750×1334, so every test sets its own size first.
 */

import React from 'react';
import { Dimensions, Text } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import { themeTokens } from '../src/theme';
import {
  PaneWidthProvider,
  WindowClassProvider,
  usePaneWidth,
  useWindowClass,
  windowClassForWidth,
} from '../src/windowClass';

const { act } = ReactTestRenderer;
const h = React.createElement;

/** Emits a real dimensions change, as a rotation or Split View drag does. */
function setWindow(width: number, height: number) {
  Dimensions.set({
    window: { width, height, scale: 2, fontScale: 2 },
  });
}

const initial = {
  window: { ...Dimensions.get('window') },
  screen: { ...Dimensions.get('screen') },
};

afterEach(() => {
  // Roots are already unmounted (jest.setup.after runs first), so restoring
  // the preset's boot dimensions notifies nobody.
  Dimensions.set(initial);
});

let classRenders = 0;
function ClassProbe() {
  classRenders += 1;
  return h(Text, { testID: 'class' }, useWindowClass());
}

let paneRenders = 0;
function PaneProbe() {
  paneRenders += 1;
  return h(Text, { testID: 'pane' }, String(usePaneWidth()));
}

beforeEach(() => {
  classRenders = 0;
  paneRenders = 0;
});

function readText(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): string {
  return String(tree.root.findByProps({ testID }).props.children);
}

test('the cuts live in the token system, at the Material values, beside an unchanged contentMax', () => {
  // Pinned constants — a drift here is a design amendment, not a tweak.
  expect(themeTokens().layout.windowClass).toEqual({
    mediumMin: 600,
    expandedMin: 840,
    listPaneMin: 320,
    listPaneMax: 360,
  });
  expect(themeTokens().layout.contentMax).toBe(520);
  // The token set is one object across palettes: layout has no dark variant.
  expect(themeTokens('dark').layout.windowClass).toBe(
    themeTokens('light').layout.windowClass,
  );
});

test('classification at the boundaries: 599/600/839/840, half-open at each cut', () => {
  expect(windowClassForWidth(599)).toBe('compact');
  expect(windowClassForWidth(600)).toBe('medium');
  expect(windowClassForWidth(839)).toBe('medium');
  expect(windowClassForWidth(840)).toBe('expanded');
  // Fractional dp exists on Android; the cut is exact, not rounded.
  expect(windowClassForWidth(599.5)).toBe('compact');
  expect(windowClassForWidth(839.9)).toBe('medium');
  // The ends of the axis.
  expect(windowClassForWidth(0)).toBe('compact');
  expect(windowClassForWidth(320)).toBe('compact');
  expect(windowClassForWidth(1366)).toBe('expanded');
  // Width-driven means a landscape phone IS expanded by width — the class
  // never asks what device it is. (What expanded RENDERS there is the wide shell's
  // decision; the classification must not lie to it.)
  expect(windowClassForWidth(844)).toBe('expanded');
});

test('the provider answers the live class across every boundary', async () => {
  setWindow(599, 1000);
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(() => {
    tree = ReactTestRenderer.create(
      h(WindowClassProvider, null, h(ClassProbe)),
    );
  });
  expect(readText(tree, 'class')).toBe('compact');

  await act(() => setWindow(600, 1000));
  expect(readText(tree, 'class')).toBe('medium');

  await act(() => setWindow(839, 1000));
  expect(readText(tree, 'class')).toBe('medium');

  await act(() => setWindow(840, 1000));
  expect(readText(tree, 'class')).toBe('expanded');

  await act(() => tree.unmount());
});

test('rotation reclassifies by the new width: an 11" iPad is medium tall, expanded wide', async () => {
  // 834×1194 is the 11" iPad in points — portrait width 834 sits BELOW the
  // 840 cut, which is exactly why the class must be width-driven per
  // orientation, not per device.
  setWindow(834, 1194);
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(() => {
    tree = ReactTestRenderer.create(
      h(WindowClassProvider, null, h(ClassProbe), h(PaneProbe)),
    );
  });
  expect(readText(tree, 'class')).toBe('medium');
  expect(readText(tree, 'pane')).toBe('834');

  // The width/height swap.
  await act(() => setWindow(1194, 834));
  expect(readText(tree, 'class')).toBe('expanded');
  expect(readText(tree, 'pane')).toBe('1194');

  // And back.
  await act(() => setWindow(834, 1194));
  expect(readText(tree, 'class')).toBe('medium');
  expect(readText(tree, 'pane')).toBe('834');

  await act(() => tree.unmount());
});

test('compact is the providerless default at any width; pane width falls back to the window', async () => {
  // A 13" window, no provider anywhere: class answers compact — the phone
  // behavior every existing screen was written against — while pane width
  // still answers the real window width, exactly what those screens read
  // from useWindowDimensions today.
  setWindow(1024, 1366);
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(() => {
    tree = ReactTestRenderer.create(h(ClassProbe, null));
  });
  expect(readText(tree, 'class')).toBe('compact');
  await act(() => tree.unmount());

  await act(() => {
    tree = ReactTestRenderer.create(h(PaneProbe, null));
  });
  expect(readText(tree, 'pane')).toBe('1024');
  // The providerless fallback tracks resizes — it is the window's number.
  await act(() => setWindow(390, 844));
  expect(readText(tree, 'pane')).toBe('390');
  await act(() => tree.unmount());
});

test('pane width is a pane fact: it coincides with the window only until a pane claims the subtree', async () => {
  setWindow(1024, 768);
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(() => {
    tree = ReactTestRenderer.create(
      h(
        WindowClassProvider,
        null,
        // A bare consumer: the window is its pane.
        h(PaneProbe),
        // A claimed subtree, as the wide shell's list pane will mount it.
        h(PaneWidthProvider, { width: 320, children: h(ClassProbe) }),
      ),
    );
  });
  // Outside any pane, pane width IS the window width — they coincide.
  expect(readText(tree, 'pane')).toBe('1024');
  // Inside the 320pt pane the CLASS is still the window's: a narrow list
  // pane in an expanded window is an expanded-shell fact, not a compact
  // phone. Only the width narrows; the policy axis does not.
  expect(readText(tree, 'class')).toBe('expanded');
  await act(() => tree.unmount());
});

test('inside a claimed pane, usePaneWidth answers the pane, not the window', async () => {
  setWindow(1024, 768);
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(() => {
    tree = ReactTestRenderer.create(
      h(
        WindowClassProvider,
        null,
        h(PaneWidthProvider, { width: 320, children: h(PaneProbe) }),
      ),
    );
  });
  expect(readText(tree, 'pane')).toBe('320');
  // A window resize does not leak into a claimed pane's width.
  await act(() => setWindow(900, 768));
  expect(readText(tree, 'pane')).toBe('320');
  await act(() => tree.unmount());
});

test('re-render contract: a same-class resize leaves class consumers alone; a crossing re-renders them', async () => {
  setWindow(390, 844);
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(() => {
    tree = ReactTestRenderer.create(
      h(WindowClassProvider, null, h(ClassProbe), h(PaneProbe)),
    );
  });
  expect(readText(tree, 'class')).toBe('compact');
  const classAfterMount = classRenders;
  const paneAfterMount = paneRenders;

  // Within compact: 390 → 400 → 599. The class value is unchanged, so the
  // provider re-renders alone and the class consumer holds still. The pane
  // consumer sizes against the number, so it tracks every change.
  await act(() => setWindow(400, 844));
  await act(() => setWindow(599, 844));
  expect(readText(tree, 'class')).toBe('compact');
  expect(classRenders).toBe(classAfterMount);
  expect(paneRenders).toBeGreaterThan(paneAfterMount);
  expect(readText(tree, 'pane')).toBe('599');

  // Crossing 600: exactly one more class render.
  await act(() => setWindow(600, 844));
  expect(readText(tree, 'class')).toBe('medium');
  expect(classRenders).toBe(classAfterMount + 1);

  // Within medium again: still nothing.
  await act(() => setWindow(700, 844));
  expect(readText(tree, 'class')).toBe('medium');
  expect(classRenders).toBe(classAfterMount + 1);

  // Crossing 840, and a height-only change never re-renders the class.
  await act(() => setWindow(840, 844));
  expect(readText(tree, 'class')).toBe('expanded');
  expect(classRenders).toBe(classAfterMount + 2);
  await act(() => setWindow(840, 600));
  expect(classRenders).toBe(classAfterMount + 2);

  await act(() => tree.unmount());
});
