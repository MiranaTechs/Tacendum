/**
 * THE ONE CLIENT-SIDE GATE ON EVERY USERNAME SURFACE (the phoneUi.ts pattern verbatim).
 *
 * Build-pinned: the claim/rename/unlink surface, the find-by-name class
 * entry, the consent toggle, and the revocation notice's rendering all
 * render ONLY under this constant. It shipped OFF in every release binary
 * through build 22 and FLIPPED ON in build 23 — after the server-side
 * flag is live and BEFORE any public copy that describes the feature,
 * so nothing ever documents a state the deployed system does not have.
 * The phone pin (phoneUi.ts) stays dark in the same build. Never a
 * runtime flag, never a remote read: what a store reviewer sees is what a
 * store binary is.
 *
 * What does NOT sit behind it, deliberately: the `usernameRevoked` notice
 * PARSER (linking.ts) and the tolerant-unknown-kind fallback — those are
 * the arming order's client half and must be in the fleet before the
 * revocation lane may run at all; a pin-OFF binary parses and stores the
 * notice and simply shows nothing (there is no name to show it against).
 *
 * The username suites drive BOTH states (a jest module mock flips this
 * constant); with it false the username surfaces render NOTHING and the
 * api spy shows zero username calls.
 *
 * Typed `boolean` deliberately, so the enabled branches stay type-checked
 * dead code rather than narrowed away.
 */
export const USERNAME_UI_ENABLED: boolean = true;
