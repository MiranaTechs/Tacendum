/**
 * Everything the update gate says, in one place. The wall and the soft card
 * share a vocabulary on purpose: a
 * person who saw the card last week must recognise the wall today.
 *
 * The store's NAME is the one platform branch. It is chosen here, at the
 * source, rather than in the screens, so the Android divergence is one
 * ternary in one file — the shape the D22 drift net expects of a
 * platform-branched string.
 */

import { Platform } from 'react-native';

/** "the App Store" or "Google Play", as this device's owner knows it. */
export const STORE_NAME = Platform.OS === 'android' ? 'Google Play' : 'the App Store';

export const UPDATE_COPY = {
  /** The hard wall. */
  title: 'Update Tacendum',
  body: 'This version can no longer connect. Update to keep your messages and calls working.',
  /** Shown INSTEAD of the button when the policy carries no store link: a
   * button cannot promise a destination we were not given. */
  where: `Update Tacendum from ${STORE_NAME} to carry on.`,
  open: `Open ${STORE_NAME}`,
  recheck: 'Check again',
  /** What a check in flight says, wherever one is. Two screens say it — the
   * wall's "Check again" and the landing screen's "Get started" — so it is
   * one string here rather than two constants that could drift apart. */
  checking: 'Checking…',

  /** The soft card, in the naming nudge's slot and shape. */
  nudgeTitle: 'Update available',
  nudgeBody: `A newer version of Tacendum is on ${STORE_NAME}. This one still works, so there is no hurry.`,
  nudgeOpen: `Open ${STORE_NAME}`,
  nudgeSkip: 'Not now',
} as const;
