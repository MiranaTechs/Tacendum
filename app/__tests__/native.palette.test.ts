/**
 * The native mirrors of theme.ts, read back from the shipped files.
 *
 * Some colours have to exist before JS does, or outside it: the iOS launch
 * frame (LaunchScreen.storyboard), the app-switcher cover drawn in Swift
 * (ScreenSecurityImpl.swift), the Android accent and system bars (both
 * styles.xml), the Android attachment previewer (PreviewActivity.kt), and
 * the fixed QR ink the dev hook and the Kotlin QR test hand to the encoder.
 * Each is a literal in its own language, so a palette pass that moves
 * theme.ts and misses one of them leaves that surface in the old palette
 * with every JS test green. This file reads each literal back and compares
 * it with the token it mirrors, so the two cannot drift apart.
 *
 * Every reader here is proved able to fail: each has a falsifier, fed the
 * shape it must read with a value planted that is not the token.
 *
 * It reads only files under app/, so it travels with the app's source.
 */

import { themeTokens } from '../src/theme';

// The app's tsconfig types only jest, so node's modules come in by `require`
// and `__dirname` by `declare` (privacy.manifest.test.ts's idiom).
const { readFileSync, existsSync } = require('fs') as {
  readFileSync: (path: string, encoding: string) => string;
  existsSync: (path: string) => boolean;
};
const { join } = require('path') as { join: (...parts: string[]) => string };
declare const __dirname: string;

const APP = join(__dirname, '..');
const read = (...parts: string[]): string =>
  readFileSync(join(APP, ...parts), 'utf8');

const light = themeTokens('light').color;
const dark = themeTokens('dark').color;
type Palette = typeof light;

// ---------------------------------------------------------------- the maths

/** 0-255 channels as an uppercase #RRGGBB. */
function hexOf(rgb: number[]): string {
  return `#${rgb
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')}`.toUpperCase();
}

/**
 * An rgba() token laid over an opaque ground, the way the screen draws it:
 * each channel is alpha x token + (1 - alpha) x ground, rounded to a byte.
 * Hex parsed by slicing, never by bitwise operators.
 */
function composite(rgba: string, ground: string): string {
  const m = /^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/.exec(rgba);
  if (!m || !/^#[0-9a-f]{6}$/i.test(ground)) {
    throw new Error(`cannot composite ${rgba} over ${ground}`);
  }
  const alpha = Number(m[4]);
  const under = [1, 3, 5].map(i => parseInt(ground.slice(i, i + 2), 16));
  return hexOf(
    [m[1], m[2], m[3]].map((byte, i) =>
      Math.round(Number(byte) * alpha + under[i] * (1 - alpha)),
    ),
  );
}

// ---------------------------------------------------------------- the readers

/** The launch view's backgroundColor: its sRGB floats, scaled to bytes. */
function storyboardGround(xml: string): string | null {
  const m =
    /<color key="backgroundColor" red="([\d.]+)" green="([\d.]+)" blue="([\d.]+)" alpha="1" colorSpace="custom" customColorSpace="sRGB"\/>/.exec(
      xml,
    );
  return m
    ? hexOf([m[1], m[2], m[3]].map(f => Math.round(Number(f) * 255)))
    : null;
}

/** `static let <name> = UIColor(red: 0xRR / 255.0, …, alpha: 1)` as #RRGGBB. */
function swiftColor(src: string, name: string): string | null {
  const m = new RegExp(
    `static let ${name} = UIColor\\(\\s*red: 0x([0-9A-Fa-f]{2}) / 255\\.0, green: 0x([0-9A-Fa-f]{2}) / 255\\.0, blue: 0x([0-9A-Fa-f]{2}) / 255\\.0, alpha: 1\\s*\\)`,
  ).exec(src);
  return m ? `#${m[1]}${m[2]}${m[3]}`.toUpperCase() : null;
}

type Bar = { kind: 'outlined' | 'solid' | 'unknown'; body: string };

/**
 * The cover mark's bars in the order they are built: each
 * `let <bar> = UIView(…)` read up to its own `mark.addSubview(<bar>)`.
 */
function coverBars(src: string): Bar[] {
  return [
    ...src.matchAll(/let (\w+) = UIView\(([\s\S]*?)mark\.addSubview\(\1\)/g),
  ].map(m => {
    const body = m[2];
    const outlined =
      /\.backgroundColor = \.clear/.test(body) &&
      /\.layer\.borderColor = pine\.cgColor/.test(body) &&
      /\.layer\.borderWidth = 0\.33 \* size/.test(body);
    const solid =
      /\.backgroundColor = pine\b/.test(body) && !/borderWidth/.test(body);
    return { kind: outlined ? 'outlined' : solid ? 'solid' : 'unknown', body };
  });
}

/** Every `<field> = Color.parseColor("#RRGGBB")`, in source order. */
function parseColors(src: string): string[] {
  return [
    ...src.matchAll(/(\w+) = Color\.parseColor\("(#[0-9A-Fa-f]{6})"\)/g),
  ].map(m => `${m[1]} ${m[2].toUpperCase()}`);
}

/**
 * A theme `<item name="…">` value, allowing attributes after the name
 * (`tools:targetApi`).
 */
function styleItem(xml: string, name: string): string | null {
  const m = new RegExp(
    `<item\\s+name="${name}"(?:\\s+[\\w:]+="[^"]*")*\\s*>\\s*([^<\\s]+)\\s*</item>`,
  ).exec(xml);
  return m ? m[1] : null;
}

/** AppearancePrefsModule's `const val NAVIGATION_BAR_<MODE> = "#RRGGBB"`. */
function navigationBarGround(
  src: string,
  mode: 'LIGHT' | 'DARK',
): string | null {
  const m = new RegExp(
    `const val NAVIGATION_BAR_${mode} = "(#[0-9A-Fa-f]{6})"`,
  ).exec(src);
  return m ? m[1].toUpperCase() : null;
}

/**
 * The Kotlin body after the first match of `signature`: from the first `{`
 * after it to the brace that closes it.
 */
function bracedBody(src: string, signature: RegExp): string | null {
  const m = signature.exec(src);
  if (!m) {
    return null;
  }
  const open = src.indexOf('{', m.index + m[0].length);
  if (open < 0) {
    return null;
  }
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') {
      depth += 1;
    } else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        return src.slice(open + 1, i);
      }
    }
  }
  return null;
}

/** True when `first` occurs in `body` and `second` occurs after it. */
function inOrder(body: string | null, first: string, second: string): boolean {
  if (body === null) {
    return false;
  }
  const at = body.indexOf(first);
  return at >= 0 && body.indexOf(second, at + first.length) >= 0;
}

/** A Kotlin `when` body as { "<choice>": result, else: result }. */
function whenBranches(body: string): Record<string, string> {
  const branches: Record<string, string> = {};
  for (const m of body.matchAll(/^\s*(?:"(\w*)"|(else)) -> (\w+)\s*$/gm)) {
    branches[m[2] ?? m[1]] = m[3];
  }
  return branches;
}

/** devhook.ts's qrRoundTrip ink: [darkHex, lightHex]. */
function devhookQrInk(src: string): string[] | null {
  const m =
    /darkHex: '(#[0-9A-Fa-f]{6})',\s*lightHex: '(#[0-9A-Fa-f]{6})'/.exec(src);
  return m ? [m[1], m[2]] : null;
}

/** QrEncodeDeterminismTest.kt's fixture ink: [DARK, LIGHT]. */
function kotlinQrInk(src: string): string[] | null {
  const ink = /const val DARK = "(#[0-9A-Fa-f]{6})"/.exec(src);
  const paper = /const val LIGHT = "(#[0-9A-Fa-f]{6})"/.exec(src);
  return ink && paper ? [ink[1], paper[1]] : null;
}

// ----------------------------------------------------------------- the files

const STORYBOARD = ['ios', 'Tacendum', 'LaunchScreen.storyboard'];
const XCASSETS = ['ios', 'Tacendum', 'Images.xcassets'];
const SWIFT = ['modules', 'screen-security', 'ios', 'ScreenSecurityImpl.swift'];
const PREVIEW = [
  'modules',
  'attach',
  'android',
  'src',
  'main',
  'java',
  'com',
  'miranatechnologies',
  'tacendum',
  'attach',
  'PreviewActivity.kt',
];
const RES = ['android', 'app', 'src', 'main', 'res'];
const MAIN_ACTIVITY = [
  'android',
  'app',
  'src',
  'main',
  'java',
  'com',
  'miranatechnologies',
  'tacendum',
  'MainActivity.kt',
];
const APPEARANCE_KT = [
  'modules',
  'tacendum-crypto',
  'android',
  'src',
  'main',
  'java',
  'com',
  'miranatechnologies',
  'tacendum',
  'crypto',
  'AppearancePrefsModule.kt',
];
const DEVHOOK = ['src', 'devhook.ts'];
const QR_KT = [
  'modules',
  'qr',
  'android',
  'src',
  'test',
  'java',
  'com',
  'miranatechnologies',
  'tacendum',
  'qr',
  'QrEncodeDeterminismTest.kt',
];

// ----------------------------------------------------------------- iOS

describe('the iOS launch frame', () => {
  test('LaunchScreen.storyboard paints the light paperGround', () => {
    expect(storyboardGround(read(...STORYBOARD))).toBe(light.paperGround);
  });

  test('no LaunchGround colour asset exists (nothing ever referenced it)', () => {
    // The sibling proves the path is right, so "absent" is not vacuous.
    expect(existsSync(join(APP, ...XCASSETS, 'AppIcon.appiconset'))).toBe(true);
    expect(existsSync(join(APP, ...XCASSETS, 'LaunchGround.colorset'))).toBe(
      false,
    );
  });

  test('the storyboard reader can fail', () => {
    const planted =
      '<color key="backgroundColor" red="0.93725490196078431" green="0.94901960784313721" blue="0.92156862745098034" alpha="1" colorSpace="custom" customColorSpace="sRGB"/>'; // vocab-allow: falsifier
    expect(storyboardGround(planted)).toBe('#EFF2EB'); // vocab-allow: falsifier
    expect(
      storyboardGround(
        '<color key="backgroundColor" white="1" alpha="1" colorSpace="calibratedWhite"/>',
      ),
    ).toBeNull();
  });
});

describe('the iOS app-switcher cover', () => {
  const swift = read(...SWIFT);

  test('paints the light paperGround and the light pine', () => {
    expect(swiftColor(swift, 'paperGround')).toBe(light.paperGround);
    expect(swiftColor(swift, 'pine')).toBe(light.pine);
  });

  test('builds the outlined bar first, at upper left, then the solid reply', () => {
    const bars = coverBars(swift);
    expect(bars.map(bar => bar.kind)).toEqual(['outlined', 'solid']);
    expect(bars[0].body).toMatch(/x: 0, y: 0, width: 2\.795 \* size/);
    expect(bars[1].body).toMatch(
      /x: 1\.545 \* size, y: \(1 \+ 0\.227\) \* size, width: 2\.955 \* size/,
    );
    expect(swift).toMatch(/let markWidth = \(1\.545 \+ 2\.955\) \* size/);
  });

  test('the colour reader can fail', () => {
    const planted = [
      '  private static let paperGround = UIColor(',
      '    red: 0xEF / 255.0, green: 0xF2 / 255.0, blue: 0xEB / 255.0, alpha: 1', // vocab-allow: falsifier
      '  )',
    ].join('\n');
    expect(swiftColor(planted, 'paperGround')).toBe('#EFF2EB'); // vocab-allow: falsifier
    expect(swiftColor(planted, 'pine')).toBeNull();
  });

  test('the bar-order reader can fail (the old order, solid first)', () => {
    const planted = [
      'let solid = UIView(frame: CGRect(x: 0, y: 0, width: 2.955 * size, height: size))',
      'solid.backgroundColor = pine',
      'mark.addSubview(solid)',
      'let reply = UIView(frame: CGRect(x: 1.545 * size, y: (1 + 0.227) * size, width: 2.795 * size, height: size))',
      'reply.backgroundColor = .clear',
      'reply.layer.borderColor = pine.cgColor',
      'reply.layer.borderWidth = 0.33 * size',
      'mark.addSubview(reply)',
    ].join('\n');
    expect(coverBars(planted).map(bar => bar.kind)).toEqual([
      'solid',
      'outlined',
    ]);
  });
});

// ----------------------------------------------------------------- Android

describe('the Android attachment previewer', () => {
  /** PreviewActivity's Palette fields, in order, for one mode. */
  const expected = (palette: Palette): string[] => [
    `ground ${palette.paperGround}`,
    `sheet ${palette.paperSheet}`,
    `inkStrong ${palette.inkStrong}`,
    `inkBody ${palette.inkBody}`,
    `inkMuted ${palette.inkMuted}`,
    `pine ${palette.pine}`,
    `onPine ${palette.onPine}`,
    // The hairline as an opaque colour: lineStrong over that mode's ground.
    `line ${composite(palette.lineStrong, palette.paperGround)}`,
  ];

  test('carries both palettes token for token, night first, then day', () => {
    expect(parseColors(read(...PREVIEW))).toEqual([
      ...expected(dark),
      ...expected(light),
    ]);
  });

  test('the parseColor reader can fail', () => {
    const planted = 'ground = Color.parseColor("#EFF2EB"),'; // vocab-allow: falsifier
    expect(parseColors(planted)).toEqual(['ground #EFF2EB']); // vocab-allow: falsifier
    expect(parseColors('ground = Color.WHITE,')).toEqual([]);
  });
});

describe.each([
  ['values', light, 'true'],
  ['values-night', dark, 'false'],
] as [string, Palette, string][])(
  'the Android theme in res/%s/styles.xml',
  (dir, palette, lightIcons) => {
    const xml = read(...RES, dir, 'styles.xml');

    test('the accent is pine, never AppCompat teal', () => {
      expect(styleItem(xml, 'colorAccent')).toBe(palette.pine);
    });

    test('both system bars are that mode’s paperGround', () => {
      expect(styleItem(xml, 'android:statusBarColor')).toBe(
        palette.paperGround,
      );
      expect(styleItem(xml, 'android:navigationBarColor')).toBe(
        palette.paperGround,
      );
    });

    test('the bar icons are dark on the light ground and light on the dark one', () => {
      expect(styleItem(xml, 'android:windowLightStatusBar')).toBe(lightIcons);
      expect(styleItem(xml, 'android:windowLightNavigationBar')).toBe(
        lightIcons,
      );
    });

    test('the API 27 attribute is marked for a minSdk 26 build', () => {
      expect(xml).toContain('xmlns:tools="http://schemas.android.com/tools"');
      expect(xml).toMatch(
        /<item name="android:windowLightNavigationBar" tools:targetApi="27">/,
      );
    });
  },
);

describe('the Android theme reader', () => {
  test('can fail', () => {
    expect(
      styleItem(
        '<item name="android:statusBarColor">#EFF2EB</item>', // vocab-allow: falsifier
        'android:statusBarColor',
      ),
    ).toBe('#EFF2EB'); // vocab-allow: falsifier
    expect(
      styleItem(
        '<item name="android:windowLightNavigationBar" tools:targetApi="27">false</item>',
        'android:windowLightNavigationBar',
      ),
    ).toBe('false');
    expect(styleItem('<resources></resources>', 'colorAccent')).toBeNull();
  });
});

describe('the Android navigation bar follows the in-app choice', () => {
  // The stylesheets above paint the launch window, and a launch theme can
  // only follow the system's day or night. RN's StatusBar reaches the status
  // bar alone, so the navigation bar is painted natively from the stored
  // choice: by MainActivity, and again by every Settings change.
  const kt = read(...APPEARANCE_KT);
  const activity = read(...MAIN_ACTIVITY);

  test('its two grounds are the two paperGrounds', () => {
    expect(navigationBarGround(kt, 'LIGHT')).toBe(light.paperGround);
    expect(navigationBarGround(kt, 'DARK')).toBe(dark.paperGround);
  });

  test('a stored choice resolves the way App.tsx resolves it', () => {
    // "dark" is dark, "system" follows the phone, and anything else
    // ("light", "" for never stored, a corrupt value) is light, the default
    // in appearance.ts. AppearanceNavigationBarTest.kt runs the same cases
    // on the JVM.
    const body = bracedBody(
      kt,
      /fun drawsDark\(choice: String, systemNight: Boolean\): Boolean =/,
    );
    expect(body === null ? null : whenBranches(body)).toEqual({
      dark: 'true',
      system: 'systemNight',
      else: 'false',
    });
  });

  test('the icon tone is set in code, so API 26 gets it too', () => {
    // The theme's windowLightNavigationBar exists only from API 27, and
    // minSdk is 26: on Android 8.0 a white bar from the theme alone keeps
    // the platform's white buttons.
    const body = bracedBody(kt, /private fun applyNavigationBar\(/);
    expect(body).toContain(
      'if (dark) NAVIGATION_BAR_DARK else NAVIGATION_BAR_LIGHT',
    );
    expect(body).toContain(
      'if (dark) 0 else WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS',
    );
    expect(body).toContain('View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR');
  });

  test('the insets controller is used only where it cannot freeze the status bar', () => {
    // Once the controller sets a window's appearance, the platform stops
    // reading the legacy light flags, the status bar's included. React
    // Native's StatusBar uses the legacy flag up to Android 11, and on 12 to
    // 14 a controller call queued before the window is attached would drop
    // the theme's light status bar. So: the controller from Android 12 once
    // attached, and always from Android 15 (where React Native queues its
    // own call for this bar); the legacy flag otherwise. Not
    // WindowInsetsControllerCompat: it calls the controller on Android 11.
    const body = bracedBody(kt, /private fun applyNavigationBar\(/);
    expect(body).toMatch(
      /if \(Build\.VERSION\.SDK_INT > Build\.VERSION_CODES\.R &&\s*\(Build\.VERSION\.SDK_INT >= 35 \|\| decor\.isAttachedToWindow\)\)/,
    );
    expect(kt).not.toMatch(/WindowInsetsControllerCompat\s*\(/);
  });

  test('MainActivity paints it after super.onCreate and on each configuration change', () => {
    const onCreate = bracedBody(
      activity,
      /override fun onCreate\(savedInstanceState: Bundle\?\)/,
    );
    expect(
      inOrder(
        onCreate,
        'super.onCreate(savedInstanceState)',
        'AppearancePrefsModule.applyNavigationBar(this)',
      ),
    ).toBe(true);
    // uiMode is in MainActivity's configChanges: a system day/night switch
    // arrives here instead of relaunching, and "system" must follow it.
    const onConfigurationChanged = bracedBody(
      activity,
      /override fun onConfigurationChanged\(newConfig: Configuration\)/,
    );
    expect(
      inOrder(
        onConfigurationChanged,
        'super.onConfigurationChanged(newConfig)',
        'AppearancePrefsModule.applyNavigationBar(this, newConfig)',
      ),
    ).toBe(true);
  });

  test('a choice made in Settings repaints it at once, on the UI thread', () => {
    const body = bracedBody(
      kt,
      /fun setAppearance\(value: String, promise: Promise\)/,
    );
    expect(
      inOrder(
        body,
        'UiThreadUtil.runOnUiThread',
        'applyNavigationBar(activity, value,',
      ),
    ).toBe(true);
    // Queued after the write, so a configuration change that re-reads the
    // stored choice in between sees the new one.
    expect(
      inOrder(
        body,
        'prefs().edit().putString(KEY, value)',
        'UiThreadUtil.runOnUiThread',
      ),
    ).toBe(true);
  });

  test('every reader can fail', () => {
    const plantedGround = 'const val NAVIGATION_BAR_LIGHT = "#EFF2EB"'; // vocab-allow: falsifier
    expect(navigationBarGround(plantedGround, 'LIGHT')).toBe('#EFF2EB'); // vocab-allow: falsifier
    expect(navigationBarGround(plantedGround, 'DARK')).toBeNull();
    // Painted before super.onCreate: the order reader says no.
    const early = [
      'override fun onCreate(savedInstanceState: Bundle?) {',
      '  AppearancePrefsModule.applyNavigationBar(this)',
      '  super.onCreate(savedInstanceState)',
      '}',
    ].join('\n');
    expect(
      inOrder(
        bracedBody(
          early,
          /override fun onCreate\(savedInstanceState: Bundle\?\)/,
        ),
        'super.onCreate(savedInstanceState)',
        'AppearancePrefsModule.applyNavigationBar(this)',
      ),
    ).toBe(false);
    // A resolver that defaults to dark reads as one.
    expect(
      whenBranches('when (choice) {\n  "light" -> false\n  else -> true\n}'),
    ).toEqual({ light: 'false', else: 'true' });
    // A missing function has no body, and an absent body is never in order.
    expect(bracedBody('class Empty', /fun setAppearance\(/)).toBeNull();
    expect(inOrder(null, 'a', 'b')).toBe(false);
  });
});

// ----------------------------------------------------------------- QR

describe('the QR fixtures use the ink the app draws with', () => {
  // QrPanel hands the encoder the LIGHT inkStrong on paperSheet in both
  // modes; the fixtures that stand in for it must draw the same code.
  const ink = [light.inkStrong, light.paperSheet];

  test('devhook.ts qrRoundTrip', () => {
    expect(devhookQrInk(read(...DEVHOOK))).toEqual(ink);
  });

  test('QrEncodeDeterminismTest.kt', () => {
    expect(kotlinQrInk(read(...QR_KT))).toEqual(ink);
  });

  test('both readers can fail', () => {
    const plantedTs = "darkHex: '#181818',\n        lightHex: '#EFF2EB',"; // vocab-allow: falsifier
    expect(devhookQrInk(plantedTs)).toEqual(['#181818', '#EFF2EB']); // vocab-allow: falsifier
    const plantedKt = 'const val DARK = "#181818"\nconst val LIGHT = "#EFF2EB"'; // vocab-allow: falsifier
    expect(kotlinQrInk(plantedKt)).toEqual(['#181818', '#EFF2EB']); // vocab-allow: falsifier
    expect(devhookQrInk('darkHex: INK,')).toBeNull();
    expect(kotlinQrInk('const val DARK = "#181818"')).toBeNull();
  });
});
