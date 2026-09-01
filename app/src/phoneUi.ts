/**
 * THE ONE CLIENT-SIDE GATE ON EVERY PHONE SURFACE.
 *
 * Build-pinned, OFF in every release binary until the phone program's own
 * release train: visible phone UI must not ship ahead of the
 * store declarations that train stages — so the AccountPhoneScreen surface, the
 * find-by-phone class entry, and the recovery door's phone entry all render
 * ONLY under this constant. Flipping it is that release train, in the
 * same binary that ships the declaration flips (the four-surfaces
 * move-together rule, made mechanical) — never a runtime flag, never a
 * remote read: what a store reviewer sees is what a store binary is.
 *
 * The phone-ux suite drives BOTH states (a jest module mock flips this
 * constant); with it false the phone surfaces render NOTHING and the email
 * suites' world is byte-unchanged.
 *
 * Typed `boolean` deliberately, so the enabled branches stay type-checked
 * dead code rather than narrowed away.
 */
export const PHONE_UI_ENABLED: boolean = false;
