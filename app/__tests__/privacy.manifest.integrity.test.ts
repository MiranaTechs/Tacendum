/**
 * The rationale in PrivacyInfo.xcprivacy is load-bearing, and `pod install`
 * deletes it.
 *
 * Observed in practice: React Native's "Privacy Manifest Aggregation" step —
 * enabled by default (react_native_pods.rb, privacy_file_aggregation_enabled:
 * true) and run from the Podfile's post_install hook on EVERY `pod install` —
 * reads app/ios/Tacendum/PrivacyInfo.xcprivacy with
 * Xcodeproj::Plist.read_from_path and unconditionally writes it back with
 * Xcodeproj::Plist.write_to_path
 * (node_modules/react-native/scripts/cocoapods/privacy_manifest_utils.rb,
 * add_aggregated_privacy_manifest). A plist parse has no representation for
 * XML comments, so the round trip silently deleted ~90 lines: the
 * NSPrivacyCollectedDataTypes preamble (what "collected" means here and why
 * the array is not empty), the
 * token-TTL decision record, and the per-type rationales. The declared
 * semantics survived, so the diff read as formatting and nothing noticed.
 *
 * Those comments are the only record of WHY each declaration exists — the
 * sign-off reasoning, kept next to the thing signed off. This guard makes
 * losing them loud, in three layers:
 *
 *   1. RATIONALE. Specific load-bearing anchor sentences must survive, and
 *      every declared data type must keep an adjacent rationale comment.
 *      Deliberately NOT a byte hash: rewording a comment or adding a type
 *      WITH its rationale passes; only losing the reasoning fails.
 *   2. SEMANTICS. The exact table of declared data types with their
 *      linked/tracking flags and purposes, and the exact required-reason API
 *      reason codes. Aggregation can also MERGE new pod-declared APIs into
 *      this file — that must be a reviewed event, not a side effect — and a
 *      purpose quietly changing (say, Analytics growing an advertising
 *      purpose) is a compliance change even though every type check passes.
 *   3. ANTI-VACUITY. The parser must actually find the declarations, so a
 *      parse regression cannot turn the layers above into no-ops. This repo
 *      has already shipped a guard whose parser matched nothing.
 *
 * Division of labor with privacy.manifest.test.ts (deliberately not edited
 * here): that file owns "the collected array is never empty", the
 * forbidden-type list, no-Linked-false / no-Tracking-true scans, and the
 * Info.plist rules (export compliance, no iPad). This file owns the rationale
 * comments and the exact signed-off tables. Overlap is intentional where it
 * exists; neither file assumes the other runs.
 */
// `require` rather than `import`, and `declare` rather than @types/node: the
// app's tsconfig carries `types: ["jest"]` only, so node's modules and
// `__dirname` are absent from the type environment even though they exist at
// runtime under Jest. Same idiom as privacy.manifest.test.ts — plus an
// `export {}` to make this file a module: that sibling compiles in script
// (global) mode, and two scripts declaring the same `readFileSync`/`__dirname`
// names collide under tsc. Module scope keeps these declarations local.
export {};
const { readFileSync } = require('fs') as {
  readFileSync: (path: string, encoding: string) => string;
};
const { join } = require('path') as { join: (...parts: string[]) => string };
declare const __dirname: string;

const MANIFEST = join(__dirname, '..', 'ios', 'Tacendum', 'PrivacyInfo.xcprivacy');

/**
 * The exact declarations compliance signed off on (the privacy data
 * inventory; see the manifest's own comments for the row-by-row trace).
 * A mismatch in EITHER direction fails: a lost or changed declaration, and
 * equally an undeclared addition. If a change here is deliberate, update this
 * table in the same commit that changes the manifest —
 * that pairing is the sign-off.
 */
const EXPECTED_DECLARATIONS: Record<
  string,
  { linked: boolean | null; tracking: boolean | null; purposes: string[] }
> = {
  NSPrivacyCollectedDataTypeEmailsOrTextMessages: {
    linked: true,
    tracking: false,
    purposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'],
  },
  NSPrivacyCollectedDataTypePhotosorVideos: {
    linked: true,
    tracking: false,
    purposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'],
  },
  NSPrivacyCollectedDataTypeAudioData: {
    linked: true,
    tracking: false,
    purposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'],
  },
  NSPrivacyCollectedDataTypeUserID: {
    linked: true,
    tracking: false,
    purposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'],
  },
  NSPrivacyCollectedDataTypeDeviceID: {
    linked: true,
    tracking: false,
    purposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'],
  },
  NSPrivacyCollectedDataTypeOtherDiagnosticData: {
    linked: true,
    tracking: false,
    purposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'],
  },
  NSPrivacyCollectedDataTypeProductInteraction: {
    linked: true,
    tracking: false,
    purposes: ['NSPrivacyCollectedDataTypePurposeAnalytics'],
  },
  // Signed off deliberately: setupMs reaches the
  // server as CallSetupLatency, and a latency measurement of an in-app
  // operation is what Apple names Performance Data. The only row with two
  // purposes, because both are true — the number gates a failure path AND is
  // read as analytics; declaring one would have been the convenient half.
  NSPrivacyCollectedDataTypePerformanceData: {
    linked: true,
    tracking: false,
    purposes: [
      'NSPrivacyCollectedDataTypePurposeAppFunctionality',
      'NSPrivacyCollectedDataTypePurposeAnalytics',
    ],
  },
  // Signed off deliberately: an email address the user CHOOSES to
  // link is transmitted for verification/recovery sends and retained as a
  // keyed scrambling on a claim row with its findability switch — Apple's
  // Contact Info → Email Address. Linked, not tracking, App Functionality
  // only. Phone Number is deliberately NOT here: phone identifiers are not enabled
  // in shipping builds.
  NSPrivacyCollectedDataTypeEmailAddress: {
    linked: true,
    tracking: false,
    purposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'],
  },
};

/**
 * The exact required-reason API declarations, category -> reason codes.
 * 3B52.1 on FileTimestamp is part of the record: it is more than React Native
 * core injects (C617.1 alone), so a naive "re-aggregate from scratch" that
 * drops it is a semantic loss this table catches.
 */
const EXPECTED_ACCESSED_APIS: Record<string, string[]> = {
  NSPrivacyAccessedAPICategoryFileTimestamp: ['C617.1', '3B52.1'],
  NSPrivacyAccessedAPICategoryUserDefaults: ['CA92.1'],
  NSPrivacyAccessedAPICategorySystemBootTime: ['35F9.1'],
};

/**
 * Load-bearing sentences that must survive any rewrite of the manifest.
 * Chosen because each is the sole record of a decision, not for their exact
 * prose — rewording around them is fine as long as the record itself stays.
 */
const RATIONALE_ANCHORS: Array<[string, string]> = [
  [
    'the disclosure reasoning (encryption protects, it does not exempt)',
    'END-TO-END ENCRYPTION IS A PROTECTION',
  ],
  [
    'the token-TTL decision record',
    'the 90-day TTL is a liveness sweep only',
  ],
];

/**
 * Every failure below carries this, because the person reading it has most
 * likely just run `pod install` and has no idea why a privacy test broke.
 */
function explain(problem: string): string {
  return [
    problem,
    '',
    'WHAT PROBABLY HAPPENED. If you recently ran `pod install`: React Native\'s',
    '"Privacy Manifest Aggregation" post-install step rewrote',
    'app/ios/Tacendum/PrivacyInfo.xcprivacy. It re-parses the file as a plist and',
    'writes it back (node_modules/react-native/scripts/cocoapods/',
    'privacy_manifest_utils.rb, add_aggregated_privacy_manifest -> Xcodeproj::Plist',
    '.write_to_path), which DELETES every XML comment — the only record of WHY each',
    'declaration exists (the token-TTL decision, the',
    'per-type rationales) — and reorders keys. It can also merge pod-declared',
    'required-reason APIs into the file. This is an App Store compliance artifact;',
    'the diff looks like formatting, and the loss is real.',
    '',
    'THE FIX IS NOT TO UPDATE THIS TEST. Restore the manifest and its rationale:',
    '    git restore app/ios/Tacendum/PrivacyInfo.xcprivacy',
    '(or re-apply the comments from git history). Only if compliance has genuinely',
    're-signed-off a changed declaration should the EXPECTED_* tables here change.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// A minimal scanner for the constrained plist shape this file actually has.
// Returns null (never a silent empty) when a landmark is missing; the
// parser-sanity test below makes null/empty loud.
// ---------------------------------------------------------------------------

/** The inner text of the <array> that immediately follows <key>key</key>. */
function extractArrayAfterKey(xml: string, key: string): string | null {
  const keyIdx = xml.indexOf(`<key>${key}</key>`);
  if (keyIdx === -1) {
    return null;
  }
  const selfClosed = /<array\s*\/>/g;
  selfClosed.lastIndex = keyIdx;
  const selfClosedMatch = selfClosed.exec(xml);
  const openIdx = xml.indexOf('<array>', keyIdx);
  if (selfClosedMatch !== null && (openIdx === -1 || selfClosedMatch.index < openIdx)) {
    return ''; // an empty <array/> — present, but declares nothing
  }
  if (openIdx === -1) {
    return null;
  }
  const tag = /<array>|<\/array>/g;
  tag.lastIndex = openIdx;
  let depth = 0;
  for (let m = tag.exec(xml); m !== null; m = tag.exec(xml)) {
    depth += m[0] === '<array>' ? 1 : -1;
    if (depth === 0) {
      return xml.slice(openIdx + '<array>'.length, m.index);
    }
  }
  return null; // unbalanced — refuse to guess
}

/** Top-level <dict>...</dict> blocks of a region, with their offsets in it. */
function dictBlocks(region: string): Array<{ body: string; start: number; end: number }> {
  const out: Array<{ body: string; start: number; end: number }> = [];
  const re = /<dict>([\s\S]*?)<\/dict>/g;
  for (let m = re.exec(region); m !== null; m = re.exec(region)) {
    out.push({ body: m[1], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

function boolAfterKey(xml: string, key: string): boolean | null {
  const m = new RegExp(`<key>${key}</key>\\s*<(true|false)\\s*/>`).exec(xml);
  return m === null ? null : m[1] === 'true';
}

function stringAfterKey(xml: string, key: string): string | null {
  const m = new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`).exec(xml);
  return m === null ? null : m[1];
}

function stringValues(region: string): string[] {
  const out: string[] = [];
  const re = /<string>([^<]*)<\/string>/g;
  for (let m = re.exec(region); m !== null; m = re.exec(region)) {
    out.push(m[1]);
  }
  return out;
}

describe('PrivacyInfo.xcprivacy integrity (rationale + signed-off semantics)', () => {
  const xml = readFileSync(MANIFEST, 'utf8');

  const collectedRegion = extractArrayAfterKey(xml, 'NSPrivacyCollectedDataTypes');
  const collectedDicts = collectedRegion === null ? [] : dictBlocks(collectedRegion);
  const declarations: Record<
    string,
    { linked: boolean | null; tracking: boolean | null; purposes: string[] }
  > = {};
  for (const d of collectedDicts) {
    const type =
      stringAfterKey(d.body, 'NSPrivacyCollectedDataType') ??
      `UNPARSEABLE_DICT_AT_OFFSET_${d.start}`;
    const purposesRegion = extractArrayAfterKey(d.body, 'NSPrivacyCollectedDataTypePurposes');
    declarations[type] = {
      linked: boolAfterKey(d.body, 'NSPrivacyCollectedDataTypeLinked'),
      tracking: boolAfterKey(d.body, 'NSPrivacyCollectedDataTypeTracking'),
      purposes: purposesRegion === null ? [] : stringValues(purposesRegion),
    };
  }

  const accessedRegion = extractArrayAfterKey(xml, 'NSPrivacyAccessedAPITypes');
  const accessedApis: Record<string, string[]> = {};
  for (const d of accessedRegion === null ? [] : dictBlocks(accessedRegion)) {
    const type =
      stringAfterKey(d.body, 'NSPrivacyAccessedAPIType') ??
      `UNPARSEABLE_DICT_AT_OFFSET_${d.start}`;
    const reasonsRegion = extractArrayAfterKey(d.body, 'NSPrivacyAccessedAPITypeReasons');
    accessedApis[type] = reasonsRegion === null ? [] : stringValues(reasonsRegion);
  }

  /** toEqual with the teaching preamble prepended to jest's diff. */
  function expectSame(actual: unknown, expected: unknown, what: string): void {
    try {
      expect(actual).toEqual(expected);
    } catch (e) {
      const diff = e instanceof Error ? e.message : String(e);
      throw new Error(`${explain(what)}\n\n${diff}`);
    }
  }

  it('parser sanity: the declarations were actually found — nothing below may pass vacuously', () => {
    // If this file is ever restructured so the scanner above stops matching,
    // this is the test that says so, instead of the rationale checks quietly
    // iterating over nothing. (The exact-table tests cannot pass on an empty
    // parse either; this one exists so the comment checks cannot go vacuous
    // if those tables are ever loosened.)
    if (collectedRegion === null || collectedDicts.length === 0) {
      throw new Error(
        explain(
          'The NSPrivacyCollectedDataTypes array (or its entries) could not be ' +
            'parsed out of the manifest at all. Either the declarations are gone ' +
            'or this test\'s scanner no longer matches the file — both are ' +
            'failures. An empty parse must never count as a pass.',
        ),
      );
    }
    if (accessedRegion === null || Object.keys(accessedApis).length === 0) {
      throw new Error(
        explain(
          'The NSPrivacyAccessedAPITypes array could not be parsed out of the ' +
            'manifest. Either the required-reason declarations are gone or this ' +
            'test\'s scanner no longer matches the file — both are failures.',
        ),
      );
    }
  });

  it('declared data types, linked/tracking flags and purposes are exactly the signed-off set', () => {
    expectSame(
      declarations,
      EXPECTED_DECLARATIONS,
      'The collected-data declarations no longer match what compliance signed ' +
        'off on (type set, Linked flag, Tracking flag, or purposes changed).',
    );
  });

  it('required-reason API declarations are exactly the signed-off categories and reason codes', () => {
    expectSame(
      accessedApis,
      EXPECTED_ACCESSED_APIS,
      'The required-reason API declarations no longer match the signed-off ' +
        'set. Aggregation merging a pod\'s API into this file, or a reason ' +
        'code being dropped (3B52.1 is more than RN core injects), lands here.',
    );
  });

  it('still declares no tracking at the top level', () => {
    expectSame(
      boolAfterKey(xml, 'NSPrivacyTracking'),
      false,
      'The top-level NSPrivacyTracking flag is no longer an explicit <false/>.',
    );
  });

  it('every declared data type keeps an adjacent rationale comment', () => {
    // Structure, not prose: between the start of the collected-types array
    // (or the end of the previous entry) and each <dict> there must be an XML
    // comment saying why that declaration exists. Adding a new type WITH its
    // rationale passes; adding one without, or stripping the comments, fails.
    const region = collectedRegion ?? '';
    const bare: string[] = [];
    let prevEnd = 0;
    for (const d of collectedDicts) {
      const gap = region.slice(prevEnd, d.start);
      if (!gap.includes('<!--')) {
        bare.push(stringAfterKey(d.body, 'NSPrivacyCollectedDataType') ?? '(unparseable type)');
      }
      prevEnd = d.end;
    }
    if (bare.length > 0) {
      throw new Error(
        explain(
          'These declared data types have NO rationale comment before their ' +
            `<dict> entry: ${bare.join(', ')}. The manifest documents WHY each ` +
            'declaration exists, right where it exists; a declaration without ' +
            'its reasoning is the stripped state this test exists to catch.',
        ),
      );
    }
  });

  it.each(RATIONALE_ANCHORS)('keeps %s', (name, anchor) => {
    // Compared with runs of whitespace flattened, because these anchors live
    // inside XML comments that get re-wrapped whenever a neighbouring
    // sentence grows. A re-wrap is not the loss this guard exists to catch —
    // losing the sentence is — and a line break splitting an anchor produced
    // a failure that said "restore the record" about a record still present.
    const flat = (s: string) => s.replace(/\s+/g, ' ');
    if (!flat(xml).includes(flat(anchor))) {
      throw new Error(
        explain(
          `The manifest lost ${name}: the anchor text "${anchor}" is no longer ` +
            'present. That sentence is the only durable record of the decision ' +
            'it describes — restore it; do not delete the anchor from this test.',
        ),
      );
    }
  });
});
