/**
 * The Podfile must keep React Native's privacy-manifest aggregation OFF.
 *
 * Observed in practice: with the default (privacy_file_aggregation_enabled: true,
 * react_native_pods.rb), EVERY `pod install` runs
 * PrivacyManifestUtils.add_aggregated_privacy_manifest, which round-trips
 * app/ios/Tacendum/PrivacyInfo.xcprivacy through Xcodeproj::Plist — a parse
 * that cannot represent XML comments — and writes it back unconditionally.
 * That silently deletes every rationale block (the E2EE-is-not-an-exemption preamble, the token-TTL decision
 * record, the per-declaration justifications): the only record of WHY each
 * App Store compliance declaration exists, lost as a diff that reads as
 * formatting.
 *
 * The fix is `:privacy_file_aggregation_enabled => false` on the
 * use_react_native! call. With the flag off, RN's fallback
 * (add_privacy_manifest_if_needed) writes only when NO manifest exists; ours
 * exists, so the file is never touched again.
 *
 * This test guards the FLAG, because the flag is one line in a file people
 * edit: drop it and the very next `pod install` re-strips the manifest with
 * no error, no warning, and a green build.
 * privacy.manifest.integrity.test.ts catches the loss after the fact; this
 * file stops the door being reopened.
 *
 * The tradeoff the flag buys, verified against a real build so it is a record, not a hope:
 * aggregation's only other job was merging pod-declared required-reason APIs
 * into our manifest. Every manifest it could merge (React-Core, React-cxxreact,
 * React-timing resource bundles; react-native-image-picker's
 * RNImagePickerPrivacyInfo bundle; RN core's hardcoded trio) declares a subset
 * of what our manifest already carries — FileTimestamp {C617.1, 3B52.1},
 * UserDefaults {CA92.1}, SystemBootTime {35F9.1}. So nothing is lost today.
 * If a FUTURE pod declares a new required-reason API, it must be added to
 * PrivacyInfo.xcprivacy BY HAND — and privacy.manifest.integrity.test.ts pins
 * the exact set, so the addition is a reviewed event either way.
 */
// `require`, not `import`, and an `export {}` to force module scope — the app
// tsconfig has no @types/node, and the sibling repo-file suites
// (podfile.pins.test.ts, privacy.manifest.integrity.test.ts) declare the same
// `readFileSync`/`join` names; module scope keeps these local. Same idiom as
// those files.
export {};

const { readFileSync } = require('fs') as {
  readFileSync: (p: string, enc: string) => string;
};
const { join } = require('path') as { join: (...parts: string[]) => string };

const PODFILE = join(__dirname, '..', 'ios', 'Podfile');

/**
 * Why every failure below carries this: the person reading it has most likely
 * just "tidied" the Podfile or resolved a merge, and has no idea a privacy
 * test should care.
 */
function explain(problem: string): string {
  return [
    problem,
    '',
    'WHY THIS FLAG EXISTS. `:privacy_file_aggregation_enabled => false` on the',
    'use_react_native! call is what stops React Native\'s post-install "Privacy',
    'Manifest Aggregation" from rewriting app/ios/Tacendum/PrivacyInfo.xcprivacy',
    'on EVERY `pod install`. The rewrite round-trips the file through',
    'Xcodeproj::Plist, which cannot represent XML comments, so it deletes every',
    'rationale block in that manifest — the',
    'token-TTL decision record, the per-declaration justifications. Those',
    'comments are the only record of WHY each App Store declaration exists, and',
    'the loss looks like a formatting diff.',
    '',
    'Remove the flag and nothing breaks visibly: the NEXT `pod install` strips',
    'the manifest silently and privacy.manifest.integrity.test.ts goes red after',
    'the damage is done. Keep the flag; the manifest already carries the union',
    'of every required-reason API our pods declare (verified 2026-08). A future',
    'pod needing a NEW required-reason API is added to PrivacyInfo.xcprivacy by',
    'hand — the integrity test pins the exact set, so that is a reviewed event.',
  ].join('\n');
}

/**
 * Drop a trailing `# comment`, respecting quotes so the `#` of a Ruby
 * interpolation ("#{Pod::Config.instance.installation_root}/..") survives.
 * Deliberately self-contained (podfile.pins.test.ts has a twin) — guard files
 * must not share a parser one edit can blind them both through.
 */
function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === '#') {
      return line.slice(0, i);
    }
  }
  return line;
}

function stripComments(source: string): string {
  return source.split('\n').map(stripComment).join('\n');
}

/**
 * The argument blocks of every `use_react_native!(...)` call, COMMENTS
 * STRIPPED FIRST — the flag must be live code, not a comment that mentions it
 * (this very Podfile's explanatory comment names the flag, so an unstripped
 * match would be satisfied by prose). Parens are counted so a wrapped,
 * multi-line call is captured whole; an unbalanced file returns [] rather
 * than a guess, which the anti-vacuity test below makes loud.
 */
function useReactNativeArgBlocks(podfileSource: string): string[] {
  const src = stripComments(podfileSource);
  const blocks: string[] = [];
  const re = /use_react_native!\s*\(/g;
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < src.length && depth > 0) {
      if (src[i] === '(') depth += 1;
      else if (src[i] === ')') depth -= 1;
      i += 1;
    }
    if (depth !== 0) return []; // unbalanced — refuse to guess
    blocks.push(src.slice(m.index + m[0].length, i - 1));
  }
  return blocks;
}

/**
 * The flag, set to false, in either syntax Ruby accepts for the same hash:
 *   :privacy_file_aggregation_enabled => false
 *   privacy_file_aggregation_enabled: false
 * A guard matching only one spelling is blind to half the ways the line can
 * be legitimately rewritten — podfile.pins.test.ts learned that the hard way.
 */
const FLAG_OFF =
  /(?::privacy_file_aggregation_enabled\s*=>|(?:^|[\s,(])privacy_file_aggregation_enabled\s*:)\s*false\b/m;

describe('Podfile keeps privacy-manifest aggregation disabled', () => {
  const podfile = readFileSync(PODFILE, 'utf8');
  const blocks = useReactNativeArgBlocks(podfile);

  it('parser sanity: found exactly one use_react_native! call, with its arguments (nothing below may pass vacuously)', () => {
    // Guards the guard. If the Podfile is restructured so the extractor stops
    // matching — or starts returning empty argument blocks — that is a
    // failure HERE, not a silent pass of the flag check below. This repo has
    // already shipped a guard whose matcher matched nothing.
    if (blocks.length !== 1) {
      throw new Error(
        explain(
          `Expected exactly one use_react_native! call in app/ios/Podfile; ` +
            `the parser found ${blocks.length}. Either the Podfile gained/lost ` +
            'a call (each one needs the flag — extend this test) or the ' +
            'extractor no longer matches the file. An empty parse must never ' +
            'count as a pass.',
        ),
      );
    }
    if (!blocks[0].includes(':path')) {
      throw new Error(
        explain(
          'The extracted use_react_native! argument block does not contain ' +
            ':path, an option known to be present. The extractor captured the ' +
            'wrong region — every assertion below would be reasoning about ' +
            'nothing.',
        ),
      );
    }
  });

  it('every use_react_native! call passes :privacy_file_aggregation_enabled => false', () => {
    for (const block of blocks) {
      if (!FLAG_OFF.test(block)) {
        throw new Error(
          explain(
            'A use_react_native! call in app/ios/Podfile no longer passes ' +
              ':privacy_file_aggregation_enabled => false (as live code — a ' +
              'comment mentioning the flag does not count). React Native ' +
              'defaults this flag to TRUE, so omitting it turns aggregation ' +
              'back on.',
          ),
        );
      }
    }
  });

  describe('the matcher itself can both match and reject (it is not silently empty)', () => {
    // Synthetic fixtures, so a rot in the comment-stripping, the paren
    // counting, or the flag regex is caught here even while the real Podfile
    // keeps the assertions above green.
    const withFlagRocket = [
      'use_react_native!(',
      '  :path => config[:reactNativePath],',
      '  :app_path => "#{Pod::Config.instance.installation_root}/..",',
      '  :privacy_file_aggregation_enabled => false',
      ')',
    ].join('\n');

    const withFlagRuby19 = withFlagRocket.replace(
      ':privacy_file_aggregation_enabled => false',
      'privacy_file_aggregation_enabled: false',
    );

    const withoutFlag = [
      'use_react_native!(',
      '  :path => config[:reactNativePath],',
      '  # :privacy_file_aggregation_enabled => false  <- only a comment',
      '  :app_path => "#{Pod::Config.instance.installation_root}/.."',
      ')',
    ].join('\n');

    const flagTrue = withFlagRocket.replace(
      ':privacy_file_aggregation_enabled => false',
      ':privacy_file_aggregation_enabled => true',
    );

    it('sees the flag through hash-rocket syntax', () => {
      const [block] = useReactNativeArgBlocks(withFlagRocket);
      expect(block).toBeDefined();
      expect(FLAG_OFF.test(block)).toBe(true);
    });

    it('sees the flag through Ruby 1.9 hash syntax', () => {
      const [block] = useReactNativeArgBlocks(withFlagRuby19);
      expect(block).toBeDefined();
      expect(FLAG_OFF.test(block)).toBe(true);
    });

    it('REJECTS a call whose only mention of the flag is a comment', () => {
      // The live Podfile's explanatory comment names the flag; if comment
      // stripping rots to a no-op, prose satisfies the flag check and the
      // guard goes blind. This fixture is that exact failure, kept red.
      const [block] = useReactNativeArgBlocks(withoutFlag);
      expect(block).toBeDefined();
      expect(block).toContain(':path'); // the extractor did capture the call
      expect(FLAG_OFF.test(block)).toBe(false);
    });

    it('REJECTS the flag set to true', () => {
      const [block] = useReactNativeArgBlocks(flagTrue);
      expect(block).toBeDefined();
      expect(FLAG_OFF.test(block)).toBe(false);
    });

    it('keeps a Ruby interpolation intact while stripping comments', () => {
      // "#{...}" contains a '#'; a naive stripper truncates the :app_path
      // line, unbalances nothing visible, and quietly reshapes the block.
      expect(stripComment('  :app_path => "#{Pod::Config.instance.root}/.." # note')).toBe(
        '  :app_path => "#{Pod::Config.instance.root}/.." ',
      );
    });
  });
});
