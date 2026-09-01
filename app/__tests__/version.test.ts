/**
 * The version the app SHOWS must be the version it IS, and the source link
 * must point at that version's tag.
 *
 * Two obligations meet in `src/version.ts`, and both fail silently when it
 * drifts. AGPL §6 requires source access for the version being conveyed —
 * "Source offers, prominent and
 * version-exact": a moving `main` does not satisfy
 * it — so a `SOURCE_URL` naming the wrong tag is a licence defect that still
 * renders a working link. And App Store guideline 5.1.1(i) wants the policy
 * reachable in the app, which is worth nothing if the build claiming to be
 * 1.0 is actually 1.1.
 *
 * The drift is not hypothetical: bumping `MARKETING_VERSION` in Xcode is a
 * different action, in a different file, from editing this TypeScript
 * constant, and nothing else in the build connects them. So this test reads
 * `project.pbxproj` — the actual source of truth for what Xcode compiles —
 * and refuses to let the two disagree.
 *
 * WHY NOT READ THE PLIST AT RUNTIME INSTEAD. That needs a native bridge for
 * a value fixed at compile time. A test is cheaper and catches the mistake
 * earlier — at `pnpm test` rather than on a device.
 */
// `require` + `declare`: the app's tsconfig carries `types: ["jest"]` only,
// so node's modules are absent from the type environment though present at
// runtime. Same idiom as privacy.manifest.test.ts.
const { readFileSync } = require('fs') as {
  readFileSync: (path: string, encoding: string) => string;
};
const { join } = require('path') as { join: (...parts: string[]) => string };
declare const __dirname: string;

import {
  BUILD,
  PRIVACY_URL,
  RELEASE_TAG,
  SOURCE_REPO,
  SOURCE_URL,
  TERMS_URL,
  VERSION,
  VERSION_LABEL,
} from '../src/version';

const PBXPROJ = join(
  __dirname,
  '..',
  'ios',
  'Tacendum.xcodeproj',
  'project.pbxproj',
);

const BUILD_GRADLE = join(
  __dirname,
  '..',
  'android',
  'app',
  'build.gradle',
);

const VERSION_PROPERTIES = join(
  __dirname,
  '..',
  'android',
  'version.properties',
);

/** Every distinct value assigned to a build setting across all configurations. */
function buildSetting(pbxproj: string, key: string): string[] {
  const matches = pbxproj.matchAll(new RegExp(`${key} = ([^;]+);`, 'g'));
  return [...new Set([...matches].map((m) => m[1]!.trim()))];
}

/**
 * Gradle with its comments removed. A `// versionCode 1` left behind in an
 * explanatory block would otherwise read as a second declaration and turn a
 * real drift check into an ambiguous one.
 */
function uncomment(gradle: string): string {
  return gradle.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/**
 * Every right-hand side Gradle assigns to a `defaultConfig` setting written in
 * the space-separated form (`versionCode <expr>`), which is how the two
 * settings under test are spelled. Returns the raw expression, NOT a value:
 * proving what the expression is, and separately what it resolves to, is the
 * whole point — a literal here is the drift this file exists to catch.
 */
function gradleSetting(gradle: string, key: string): string[] {
  const matches = uncomment(gradle).matchAll(
    new RegExp(`^\\s*${key}\\s+(.+?)\\s*$`, 'gm'),
  );
  return [...matches].map((m) => m[1]!);
}

/** A java.util.Properties file as Gradle's own loader would read it. */
function properties(source: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const line of source.split(/\r?\n/)) {
    const match = /^\s*([^#!:=\s]+)\s*[=:]\s*(.*?)\s*$/.exec(line);
    if (match) parsed[match[1]!] = match[2]!;
  }
  return parsed;
}

describe('version constants track the Xcode project', () => {
  const pbxproj = readFileSync(PBXPROJ, 'utf8');

  it('VERSION equals MARKETING_VERSION', () => {
    const values = buildSetting(pbxproj, 'MARKETING_VERSION');
    // One value across every configuration. Two would mean the app and the
    // extension disagree, which ships an .ipa Apple rejects at upload.
    expect(values).toEqual([VERSION]);
  });

  it('BUILD equals CURRENT_PROJECT_VERSION', () => {
    const values = buildSetting(pbxproj, 'CURRENT_PROJECT_VERSION');
    expect(values).toEqual([BUILD]);
  });
});

/**
 * THE SAME OBLIGATION, THE OTHER STORE.
 *
 * Both stores must always name the same number, so `versionCode` is the shared
 * BUILD counter and `versionName` is VERSION — one counter, two stores, and
 * `1.0 (16)` in Settings means the same build on either phone.
 *
 * WHY THIS TAKES TWO HOPS AND THE XCODE PIN TAKES ONE. Gradle cannot read
 * TypeScript, so `app/android/app/build.gradle` reads
 * `app/android/version.properties` and this test walks the chain rather than
 * asserting one end of it: build.gradle names the properties file, its two
 * settings resolve to the two values loaded from that file, and the file's two
 * values equal BUILD and VERSION. Pinning only the properties file would let
 * someone hardcode `versionCode 1` in build.gradle and still go green — the
 * properties file would be right and unread, which is the honest accident this
 * arrangement invites. Every link is checked because breaking any one of them
 * ships an .aab whose number is not the number the app displays, and Play, like
 * App Store Connect, refuses a repeat versionCode: the recovery from shipping
 * the wrong one is burning it, permanently.
 */
describe('version constants track the Android Gradle build', () => {
  const gradle = readFileSync(BUILD_GRADLE, 'utf8');
  const declared = properties(readFileSync(VERSION_PROPERTIES, 'utf8'));

  it('build.gradle reads the shared counter instead of carrying literals', () => {
    // The file is named, so the two `def`s below have something to load.
    expect(uncomment(gradle)).toMatch(
      /file\(\s*["']\.\.\/version\.properties["']\s*\)/,
    );
    // versionCode: properties → text → integer → defaultConfig. Each hop
    // spelled out, because a mutation at any hop is a shipped wrong number.
    expect(gradleSetting(gradle, 'versionCode')).toEqual([
      'tacendumVersionCode',
    ]);
    expect(uncomment(gradle)).toMatch(
      /def\s+tacendumVersionCode\s*=\s*tacendumVersionCodeText\.toInteger\(\)/,
    );
    expect(uncomment(gradle)).toMatch(
      /def\s+tacendumVersionCodeText\s*=\s*versionProperties\.getProperty\(\s*["']VERSION_CODE["']/,
    );
    // versionName: properties → defaultConfig, one hop fewer, same rule.
    expect(gradleSetting(gradle, 'versionName')).toEqual([
      'tacendumVersionName',
    ]);
    expect(uncomment(gradle)).toMatch(
      /def\s+tacendumVersionName\s*=\s*versionProperties\.getProperty\(\s*["']VERSION_NAME["']/,
    );
  });

  it('versionCode equals BUILD', () => {
    expect(declared.VERSION_CODE).toBe(BUILD);
    // Play orders uploads by this number and it must be a positive integer;
    // build.gradle throws on anything else, and a throw at build time is a
    // worse place to learn it than here.
    expect(declared.VERSION_CODE).toMatch(/^[1-9][0-9]*$/);
  });

  it('versionName equals VERSION', () => {
    expect(declared.VERSION_NAME).toBe(VERSION);
  });
});

describe('the source offer is BUILD-exact (AGPL §6)', () => {
  it('SOURCE_URL names this build’s tag, not a branch', () => {
    expect(SOURCE_URL).toBe(`${SOURCE_REPO}/tree/${RELEASE_TAG}`);
    // The specific failure this guards: someone "fixes" a 404 during
    // development by pointing the link at main. That resolves, looks
    // correct, and stops corresponding to the binary.
    expect(SOURCE_URL).not.toMatch(/\/(main|master|HEAD)$/);
  });

  /**
   * THE TAG MUST PIN THE BUILD, NOT JUST THE VERSION. The predecessor of
   * this test only checked that VERSION appeared in the URL, and that is
   * exactly how sixteen builds shipped whose "Source code" row all pointed
   * at v1.0 — a tree that stayed frozen at build 1 while the code moved
   * 240+ commits past it. A version-only tag satisfies a version-only test
   * for every BUILD forever; a build-exact tag cannot drift without this
   * file going red.
   *
   * WHY DERIVING THE EXPECTATION FROM BUILD IS HONEST HERE, when deriving
   * from VERSION alone was the hole: BUILD is not free-floating — the
   * describes above pin it to `project.pbxproj`'s CURRENT_PROJECT_VERSION
   * and to `version.properties`' VERSION_CODE. So the chain is closed:
   * the binary's build number equals BUILD, and RELEASE_TAG must embed
   * BUILD. Hardcoding `v1.0-b16` here instead would only add a third
   * mirror to bump, guarded by nothing.
   */
  it('RELEASE_TAG pins the BUILD, not just the VERSION', () => {
    expect(RELEASE_TAG).toBe(`v${VERSION}-b${BUILD}`);
    // Shape pin: a tag like `v1.0-b` or `v1.0-b0` is not a build.
    expect(RELEASE_TAG).toMatch(/^v\d+\.\d+(?:\.\d+)?-b[1-9]\d*$/);
  });

  it('SOURCE_URL carries the version AND the build it ships with', () => {
    expect(SOURCE_URL).toContain(VERSION);
    // Bumping BUILD without the tag following must fail here — this is the
    // assertion whose absence let sixteen builds ride build 1's source.
    expect(SOURCE_URL).toContain(`-b${BUILD}`);
  });
});

describe('the URLs the About screen opens', () => {
  it('are https and on the published domains', () => {
    for (const url of [PRIVACY_URL, TERMS_URL, SOURCE_URL]) {
      expect(url).toMatch(/^https:\/\//);
    }
    expect(SOURCE_REPO).toBe('https://github.com/MiranaTechs/Tacendum');
  });

  it('use the exact policy paths the web stack pins', () => {
    // One cross-repo agreement: these paths are pinned by
    // redirect tests in a DIFFERENT repo, and the /privacy/ URL is also
    // typed by hand into App Store Connect. A layout drift breaks something
    // no test on either side would see — so both trailing slashes matter.
    expect(PRIVACY_URL).toBe('https://tacendum.com/privacy/');
    expect(TERMS_URL).toBe('https://tacendum.com/terms/');
  });

  it('VERSION_LABEL reads as "version (build)"', () => {
    expect(VERSION_LABEL).toBe(`${VERSION} (${BUILD})`);
  });
});
