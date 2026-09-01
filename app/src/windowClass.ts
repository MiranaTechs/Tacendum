import React, { createContext, useContext } from 'react';
import { useWindowDimensions } from 'react-native';
import { themeTokens } from './theme';

/**
 * The window-class axis of the shared shell.
 *
 * One shared WindowClass shell: compact <600dp, medium 600–839dp, expanded
 * ≥840dp — the Material cuts, driven by `useWindowDimensions`. WIDTH-DRIVEN,
 * NEVER IDIOM-DRIVEN: iPadOS windows and Android multi-window resize
 * continuously, so "is an iPad" answers nothing — a phone-width window on any
 * device must behave exactly like the phone app. Compact is the universal
 * fallback at any width.
 *
 * This ships exported and deliberately unused by screens: zero screens
 * migrated, zero behavior change. The wide projection mounts the provider
 * later; screens adopt `usePaneWidth` mechanically.
 */

export type WindowClass = 'compact' | 'medium' | 'expanded';

/** The cuts live in the token system (theme.ts, beside contentMax) — one
 * source for the shell, the panes, and any future surface. Layout tokens are
 * identical across palettes, so the mode-free default resolution is exact. */
const cuts = themeTokens().layout.windowClass;

/**
 * Pure classification, for code outside render — tests and tooling — and for
 * the provider itself. Components read the live class with useWindowClass().
 * (The themeTokens() discipline.)
 */
export function windowClassForWidth(width: number): WindowClass {
  if (width >= cuts.expandedMin) return 'expanded';
  if (width >= cuts.mediumMin) return 'medium';
  return 'compact';
}

/**
 * Compact is the DEFAULT context value, not just a fallback: a component
 * rendered without a provider (a test, a stray portal) gets the phone
 * behavior the app has always had, and no call site needs to change for the
 * wide shell to exist. (The theme.ts light-default discipline.)
 */
const WindowClassContext = createContext<WindowClass>('compact');

/**
 * The width of the PANE a component renders in — a different fact from the
 * window's width. `null` means "no pane has claimed this subtree", and
 * usePaneWidth then answers the window width: in compact, where the window
 * is the only pane, the two coincide by construction.
 */
const PaneWidthContext = createContext<number | null>(null);

/**
 * Owns "how wide is this window, and what class is that" for everything
 * below it. Mounted once at the shell root; never per screen.
 *
 * Re-render contract (windowclass.test.ts pins it): the class value only
 * changes when a resize CROSSES the 600/840 cuts, so useWindowClass
 * consumers re-render on a class change and hold still through a same-class
 * resize — the context value is a string compared by identity, and the
 * stable children element lets React bail out of the subtree and walk only
 * consumers. usePaneWidth consumers track every width change; they size
 * against the number.
 */
export function WindowClassProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const { width } = useWindowDimensions();
  return React.createElement(
    WindowClassContext.Provider,
    { value: windowClassForWidth(width) },
    React.createElement(PaneWidthContext.Provider, { value: width }, children),
  );
}

/**
 * Claims a subtree for a pane of the given width in dp. The wide projection
 * wraps each pane in one of these; nothing mounts it in compact.
 */
export function PaneWidthProvider({
  width,
  children,
}: {
  width: number;
  children: React.ReactNode;
}) {
  return React.createElement(
    PaneWidthContext.Provider,
    { value: width },
    children,
  );
}

/** The window's class. Layout POLICY (how many panes, rail vs tab bar) keys
 * off this; element sizing does not — that is usePaneWidth's job. */
export function useWindowClass(): WindowClass {
  return useContext(WindowClassContext);
}

/**
 * The width a component should SIZE AGAINST — its pane, never the window.
 * Under the wide shell a screen lives in a pane narrower than its window, so
 * reading useWindowDimensions().width there is a layout bug by construction;
 * this hook is the drop-in replacement that makes the migration mechanical.
 * With no pane and no provider it answers exactly the window width — today's
 * value on today's phones.
 */
export function usePaneWidth(): number {
  const paneWidth = useContext(PaneWidthContext);
  // Subscribed unconditionally (hooks may not branch): the providerless and
  // compact answers are the window's, so the fallback must track resizes.
  const { width: windowWidth } = useWindowDimensions();
  return paneWidth ?? windowWidth;
}
