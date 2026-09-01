/**
 * THE ONE DOOR TO THE OS SHARE SHEET ("Share anchor sites, exactly four,
 * all through the pinned `shareWithAnchor`
 * helper").
 *
 * On the phone idiom `Share.share` presents a bottom sheet and an anchor is
 * meaningless. On iPad the same call presents a POPOVER, and un-anchored it
 * floats detached in the centre of the window (the probe row: no crash,
 * just a sheet pointing at nothing) — on a 13" screen, nowhere near the
 * control that asked for it. RN's iOS options already carry the fix: `anchor`,
 * a native node handle the popover attaches to.
 *
 * Every share site passes the ref of the control that was just pressed; the
 * helper resolves it to a node handle at call time — not at render, because
 * the handle only exists once the view is mounted. A ref that resolves to
 * nothing degrades to today's centred presentation rather than refusing to
 * share: the anchor is a courtesy of placement, never a precondition of the
 * feature. Android ignores `anchor` entirely (the chooser is a full-screen
 * intent), so one code path serves both platforms.
 *
 * Content rules stay at the call sites, where their reasons live (`url` XOR
 * `message`; never both — iOS ranks Safari above Messages otherwise).
 */

import {
  findNodeHandle,
  Share,
  type ShareAction,
  type ShareContent,
  type View,
} from 'react-native';

/** The ref of the control the share sheet should point at. */
export type ShareAnchor = { readonly current: View | null } | null | undefined;

export function shareWithAnchor(
  content: ShareContent,
  anchor: ShareAnchor,
): Promise<ShareAction> {
  const node =
    anchor?.current != null ? findNodeHandle(anchor.current) : null;
  return Share.share(content, node != null ? { anchor: node } : {});
}
