import { PHONE_UI_ENABLED } from './phoneUi';
import { USERNAME_UI_ENABLED } from './usernameUi';

/**
 * WHICH FINDABLE CLASSES ARE LIVE IN THIS BINARY, as two census-clean facts
 * (the proof pass, 2026-10-08). The email deck and the Email screen may
 * not spell the handle class's name (username-plumbing's word census) nor
 * import its pin, yet their sentences depend on whether ANOTHER findable
 * class exists: "off means nobody can look you up — by this email or
 * anything else" has been false since the handle class went live, and the
 * downgrade removes the handle too. This module reads both pins ONCE and
 * answers in class-neutral words; it is on the census's allowlists under
 * its own name, and nothing else of the handle class travels through it.
 */

/** The handle class renders in this build (its pin). */
export const HANDLE_CLASS_LIVE: boolean = USERNAME_UI_ENABLED;

/** Some findable class OTHER than email is live: the email sentences must
 * scope themselves to "by this email" and say the other switch is its own. */
export const OTHER_FINDABLE_CLASS_LIVE: boolean = USERNAME_UI_ENABLED || PHONE_UI_ENABLED;
