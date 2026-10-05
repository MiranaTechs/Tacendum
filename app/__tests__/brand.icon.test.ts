/**
 * The home-screen icons are brand art, and brand art regresses silently: a
 * regenerated PNG or a "tidied" drawable looks plausible in a diff, and no
 * other suite reads its colours. These checks pin the launcher and the app
 * icon to the brand's two colours, white #FFFFFF and forest #0E6B45, written
 * here as literals rather than read from theme.ts on purpose: the icon is the
 * brand itself, not a themed surface, and must not move when the app palette
 * does.
 *
 * Android draws the adaptive icon on every supported device (minSdk 26): a
 * white background layer, the two bars in forest as the foreground, and a
 * monochrome layer the launcher tints for themed icons. The upper-left bar is
 * OUTLINED and the lower-right bar SOLID: the two are told apart by value,
 * never by hue, so the outlined path keeps a transparent fill in both
 * drawables (a filled path turns the mark into two solid bars). The legacy
 * mipmap PNGs stay as fallbacks, and the iOS asset catalog keeps exactly its
 * light and dark entries, the light icon opaque (the App Store rejects an app
 * icon with an alpha channel).
 *
 * Reads only files under app/. PNG headers are parsed with arithmetic, not
 * bit operators.
 */
// `require`, not `import`, and an `export {}` to force module scope: the app
// tsconfig has no @types/node, and sibling repo-file suites declare the same
// `readFileSync`/`join` names. Same idiom as podfile.privacy.suppression.test.ts.
export {};

const { readFileSync, readdirSync } = require('fs') as {
  readFileSync: {
    (path: string, encoding: string): string;
    (path: string): Uint8Array;
  };
  readdirSync: (path: string) => string[];
};
const { join } = require('path') as { join: (...parts: string[]) => string };
const { spawnSync } = require('child_process') as {
  spawnSync: (
    command: string,
    args: string[],
    options: { cwd: string; encoding: string },
  ) => { status: number | null; stdout: string };
};

const testPath = expect.getState().testPath ?? '';
const APP = testPath.slice(0, testPath.lastIndexOf('/__tests__/'));
const RES = join(APP, 'android', 'app', 'src', 'main', 'res');
const APP_ICON = join(
  APP,
  'ios',
  'Tacendum',
  'Images.xcassets',
  'AppIcon.appiconset',
);

const WHITE = '#FFFFFF';
const FOREST = '#0E6B45';
const BLACK = '#000000';
/** A VectorDrawable's transparent colour: the outlined bar's interior. */
const CLEAR = '#00000000';
/** The app icon's two bars as VectorDrawable paths (1024 space). */
const OPENING_BAR =
  'M300.5,400 h228 a42.5,42.5 0 0 1 0,85 h-228 a42.5,42.5 0 0 1 0,-85 z';
const ANSWER_BAR =
  'M496.5,535 h248 a63.5,63.5 0 0 1 0,127 h-248 a63.5,63.5 0 0 1 0,-127 z';
const DRAWABLES = ['ic_launcher_foreground', 'ic_launcher_monochrome'];
const DENSITIES: ReadonlyArray<readonly [string, number]> = [
  ['mdpi', 48],
  ['hdpi', 72],
  ['xhdpi', 96],
  ['xxhdpi', 144],
  ['xxxhdpi', 192],
];
/** PNG colour types that carry an alpha channel (grey + alpha, RGBA). */
const ALPHA_COLOUR_TYPES = [4, 6];

type Attrs = Record<string, string>;

const uncomment = (xml: string): string => xml.replace(/<!--[\s\S]*?-->/g, '');
const readRes = (...parts: string[]): string =>
  uncomment(readFileSync(join(RES, ...parts), 'utf8'));
const attrsOf = (tag: string): Attrs => {
  const attrs: Attrs = {};
  for (const m of tag.matchAll(/android:(\w+)="([^"]*)"/g)) {
    attrs[m[1] ?? ''] = m[2] ?? '';
  }
  return attrs;
};
/** Every `<name …>` element's android: attributes, in document order. */
const elements = (xml: string, name: string): Attrs[] =>
  [...xml.matchAll(new RegExp(`<${name}\\b([^>]*)>`, 'g'))].map(m =>
    attrsOf(m[1] ?? ''),
  );
const colourLiterals = (xml: string): string[] =>
  (xml.match(/#[0-9A-Fa-f]{3,8}\b/g) ?? []).sort();
const drawable = (name: string) => {
  const xml = readRes('drawable', `${name}.xml`);
  return {
    xml,
    vectors: elements(xml, 'vector'),
    groups: elements(xml, 'group'),
    paths: elements(xml, 'path'),
  };
};

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const u32 = (bytes: Uint8Array, at: number): number =>
  ((bytes[at] * 256 + bytes[at + 1]) * 256 + bytes[at + 2]) * 256 +
  bytes[at + 3];
/** Size, colour type and chunk list of a PNG, read from its own bytes. */
const pngHeader = (path: string) => {
  const bytes = readFileSync(path);
  expect(Array.from(bytes.subarray(0, 8))).toEqual(PNG_SIGNATURE);
  const chunks: string[] = [];
  let at = 8;
  while (at + 8 <= bytes.length) {
    chunks.push(
      String.fromCharCode(
        bytes[at + 4],
        bytes[at + 5],
        bytes[at + 6],
        bytes[at + 7],
      ),
    );
    at += 12 + u32(bytes, at);
  }
  return {
    width: u32(bytes, 16),
    height: u32(bytes, 20),
    colourType: bytes[25],
    chunks,
  };
};
const trackedRes = (): string[] => {
  const listed = spawnSync(
    'git',
    ['ls-files', '-z', '--', 'android/app/src/main/res'],
    { cwd: APP, encoding: 'utf8' },
  );
  expect(listed.status).toBe(0);
  return listed.stdout.split('\0').filter(Boolean);
};

describe('the Android adaptive launcher icon', () => {
  it('the manifest names the launcher, and both adaptive icons name the white background, the forest foreground and the monochrome layer', () => {
    const manifest = uncomment(
      readFileSync(
        join(APP, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'),
        'utf8',
      ),
    );
    expect(manifest).toContain('android:icon="@mipmap/ic_launcher"');
    expect(manifest).toContain('android:roundIcon="@mipmap/ic_launcher_round"');

    for (const name of ['ic_launcher.xml', 'ic_launcher_round.xml']) {
      const xml = readRes('mipmap-anydpi-v26', name);
      expect(xml).toMatch(/<adaptive-icon\b/);
      expect(elements(xml, 'background')).toEqual([
        { drawable: '@color/ic_launcher_background' },
      ]);
      expect(elements(xml, 'foreground')).toEqual([
        { drawable: '@drawable/ic_launcher_foreground' },
      ]);
      expect(elements(xml, 'monochrome')).toEqual([
        { drawable: '@drawable/ic_launcher_monochrome' },
      ]);
    }
  });

  it('the background layer is white, and defined once, so no mode can tint it', () => {
    const definitions = readdirSync(RES)
      .filter(dir => /^values(-|$)/.test(dir))
      .flatMap(dir =>
        readdirSync(join(RES, dir))
          .filter(file => file.endsWith('.xml'))
          .map(file => readRes(dir, file)),
      )
      .flatMap(xml =>
        [
          ...xml.matchAll(
            /<color\s+name="ic_launcher_background"\s*>\s*([^<\s]+)\s*<\/color>/g,
          ),
        ].map(m => m[1]),
      );
    expect(definitions).toEqual([WHITE]);
  });

  it('both drawables frame the bars identically: a 108dp layer with the 1024 icon space mapped onto its 72dp visible area', () => {
    for (const name of DRAWABLES) {
      const { vectors, groups, paths } = drawable(name);
      expect(vectors).toEqual([
        {
          width: '108dp',
          height: '108dp',
          viewportWidth: '108',
          viewportHeight: '108',
        },
      ]);
      expect(groups).toEqual([
        {
          translateX: '18',
          translateY: '18',
          scaleX: '0.0703125',
          scaleY: '0.0703125',
        },
      ]);
      expect(paths.map(path => path.pathData)).toEqual([
        OPENING_BAR,
        ANSWER_BAR,
      ]);
    }
  });

  it('the foreground draws both bars in forest at full strength, and no other colour', () => {
    const { xml, paths } = drawable('ic_launcher_foreground');
    expect(paths).toEqual([
      {
        strokeColor: FOREST,
        strokeWidth: '42',
        fillColor: CLEAR,
        pathData: OPENING_BAR,
      },
      { fillColor: FOREST, pathData: ANSWER_BAR },
    ]);
    // Every colour in the file is forest, but the outlined bar's interior.
    expect(colourLiterals(xml)).toEqual([CLEAR, FOREST, FOREST].sort());
    // An alpha below one would draw the forest as a pale tint.
    expect(xml).not.toMatch(/android:(fill|stroke)?alpha=/i);
  });

  it('the monochrome layer draws the same two bars in black, for the launcher to tint', () => {
    const { xml, paths } = drawable('ic_launcher_monochrome');
    expect(paths).toEqual([
      {
        strokeColor: BLACK,
        strokeWidth: '42',
        fillColor: CLEAR,
        pathData: OPENING_BAR,
      },
      { fillColor: BLACK, pathData: ANSWER_BAR },
    ]);
    expect(colourLiterals(xml)).toEqual([BLACK, BLACK, CLEAR].sort());
    expect(xml).not.toMatch(/android:(fill|stroke)?alpha=/i);
  });

  it('the opening bar stays outlined in both drawables: a transparent fill, never a second solid bar', () => {
    for (const name of DRAWABLES) {
      const opening = drawable(name).paths.find(
        path => path.pathData === OPENING_BAR,
      );
      expect(opening?.fillColor).toBe(CLEAR);
      expect(opening?.strokeWidth).toBe('42');
    }
  });
});

describe('the launcher PNG fallbacks and the iOS app icon', () => {
  it('every density tracks both launcher PNGs at its own size, beside the tracked adaptive set', () => {
    const tracked = trackedRes();
    const onDisk = readdirSync(RES).filter(dir =>
      /^mipmap-(?!any)[a-z]+dpi$/.test(dir),
    );
    expect(onDisk.sort()).toEqual(
      DENSITIES.map(([density]) => `mipmap-${density}`).sort(),
    );

    for (const [density, size] of DENSITIES) {
      for (const name of ['ic_launcher.png', 'ic_launcher_round.png']) {
        expect(tracked).toContain(
          `android/app/src/main/res/mipmap-${density}/${name}`,
        );
        const { width, height } = pngHeader(
          join(RES, `mipmap-${density}`, name),
        );
        expect([width, height]).toEqual([size, size]);
      }
    }

    for (const resource of [
      'mipmap-anydpi-v26/ic_launcher.xml',
      'mipmap-anydpi-v26/ic_launcher_round.xml',
      'drawable/ic_launcher_foreground.xml',
      'drawable/ic_launcher_monochrome.xml',
      'values/ic_launcher_background.xml',
    ]) {
      expect(tracked).toContain(`android/app/src/main/res/${resource}`);
    }
  });

  it('the iOS asset catalog keeps exactly its light and dark entries, and the light icon has no alpha', () => {
    const contents = JSON.parse(
      readFileSync(join(APP_ICON, 'Contents.json'), 'utf8'),
    ) as { images: unknown[] };
    expect(contents.images).toEqual([
      {
        filename: 'icon-1024.png',
        idiom: 'universal',
        platform: 'ios',
        size: '1024x1024',
      },
      {
        appearances: [{ appearance: 'luminosity', value: 'dark' }],
        filename: 'icon-1024-dark.png',
        idiom: 'universal',
        platform: 'ios',
        size: '1024x1024',
      },
    ]);

    const light = pngHeader(join(APP_ICON, 'icon-1024.png'));
    expect([light.width, light.height]).toEqual([1024, 1024]);
    // No alpha channel, and no tRNS chunk adding transparency back.
    expect(ALPHA_COLOUR_TYPES).not.toContain(light.colourType);
    expect(light.chunks).not.toContain('tRNS');

    // The dark-appearance icon is the one transparent asset: the system
    // supplies the dark plate behind it.
    const dark = pngHeader(join(APP_ICON, 'icon-1024-dark.png'));
    expect([dark.width, dark.height]).toEqual([1024, 1024]);
    expect(
      ALPHA_COLOUR_TYPES.includes(dark.colourType) ||
        dark.chunks.includes('tRNS'),
    ).toBe(true);
  });
});
