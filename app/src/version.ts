/**
 * What this build is, and where its source lives.
 *
 * WHY THESE ARE CONSTANTS AND NOT READ FROM THE BUNDLE. Reading
 * `CFBundleShortVersionString` at runtime needs a native bridge, and the
 * bridge would be an extra moving part for a value that is fixed at compile
 * time anyway. Instead the numbers live here once and a test
 * (`version.test.ts`) pins them to `project.pbxproj`'s `MARKETING_VERSION`
 * and `CURRENT_PROJECT_VERSION`. Bump the Xcode setting without bumping this
 * file and the suite fails, which is the only failure mode worth guarding:
 * a Settings screen quietly claiming to be a version it is not.
 *
 * WHY THE SOURCE URL IS DERIVED RATHER THAN WRITTEN. AGPL §6 requires source
 * access for *the version being conveyed* — a moving `main` does not
 * satisfy it. A hand-typed URL rots
 * the first time someone bumps the version and forgets, and the failure is
 * silent: the link still works, it just points at the wrong tree. Building it
 * from `VERSION` makes the two impossible to separate.
 */

/**
 * Matches MARKETING_VERSION in app/ios/Tacendum.xcodeproj/project.pbxproj —
 * and VERSION_NAME in app/android/version.properties.
 */
export const VERSION = '1.0';

/**
 * Matches CURRENT_PROJECT_VERSION. Increments on every upload, including
 * rejected and superseded ones — App Store Connect refuses a repeat.
 *
 * THIS IS ONE COUNTER FOR BOTH STORES. The same number is Android's `versionCode`, mirrored into
 * `app/android/version.properties` as VERSION_CODE because Gradle cannot read
 * TypeScript — `app/android/app/build.gradle` loads that file rather than
 * carrying a literal. Play refuses a repeated versionCode exactly as ASC
 * refuses a repeated build, so bumping this constant means bumping BOTH
 * mirrors: the pbxproj pair and the properties pair. `version.test.ts` walks
 * both chains and fails if either disagrees, which is the only reason a hand-
 * maintained mirror is safe to have.
 */
export const BUILD = '24';

/** What Settings shows, and what a bug report should quote. */
export const VERSION_LABEL = `${VERSION} (${BUILD})`;

/**
 * The release tag this build is cut from. Each release freezes exactly one
 * commit and tags it; everything downstream — the
 * archive, the published source — refers to that tag.
 *
 * BUILD-EXACT, NOT VERSION-EXACT. `v${VERSION}` alone was the defect this
 * scheme replaces: VERSION stays `1.0` across every upload while BUILD
 * increments, so a version-only tag meant every upload pointing at
 * the first build's tree — far behind the binaries carrying the
 * link. AGPL §6 wants source for the version BEING CONVEYED, and what is
 * conveyed is a build. One tag per shipped build: `v1.0-b16`, `v1.0-b17`, …
 *
 * THE TAG MUST EXIST IN THE PUBLIC REPO AT RELEASE TIME. Nothing here can
 * create it — the release process cuts `v${VERSION}-b${BUILD}` on
 * the frozen commit and pushes it to SOURCE_REPO before the build ships.
 * `version.test.ts` pins that this constant embeds BUILD, so bumping BUILD
 * without the tag (and this derivation) following is unlandable.
 */
export const RELEASE_TAG = `v${VERSION}-b${BUILD}`;

/** Public repository root. */
export const SOURCE_REPO = 'https://github.com/MiranaTechs/Tacendum';

/**
 * The immutable, version-exact source URL for THIS build. Not a branch.
 *
 * This is the link the app shows and the one an App Review reader follows.
 * It shows this build's source only once the release has published the tag —
 * but do NOT expect a 404 before then, and never "verify" publication by
 * status code: GitHub answers an EMPTY repository with HTTP 200 (its setup
 * page — no tree, no matching tag), so the URL can return 200 while serving
 * nothing at all. The only check that means anything is opening the tag's
 * tree and seeing the source. A page with no source is still the honest
 * state, and preferable to pointing at a `main` that does not correspond to
 * the binary.
 */
export const SOURCE_URL = `${SOURCE_REPO}/tree/${RELEASE_TAG}`;

/** Published policy pages. The site serves these exact paths — do not
 * change one unilaterally. */
export const PRIVACY_URL = 'https://tacendum.com/privacy/';
export const TERMS_URL = 'https://tacendum.com/terms/';
