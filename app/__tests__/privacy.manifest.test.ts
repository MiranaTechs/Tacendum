/**
 * The privacy manifest must declare what the service actually keeps.
 *
 * `NSPrivacyCollectedDataTypes` was once an empty array, and an
 * empty array is a POSITIVE CLAIM — "this app collects nothing" — not a
 * neutral default. It was false. The relay stores queued ciphertext for 30
 * days, attachment blobs for 30, and APNs device tokens for 90; Apple counts
 * data as collected when it leaves the device and is retained, and end-to-end
 * encryption is a protection, not an exemption from disclosure. The whole
 * industry declares here: Signal, WhatsApp and iMessage all do.
 *
 * WHY A TEST RATHER THAN A COMMENT. The failure mode is not someone
 * disagreeing with the declaration — it is the array quietly returning to
 * `[]`, which is exactly what an "unused key, tidy it up" edit produces, and
 * which nothing else in the build would notice. A false App Privacy label is
 * a submission Apple can reject automatically by comparing the manifest to
 * the questionnaire, so the regression is expensive and silent. This test
 * makes emptying it loud.
 *
 * WHAT IT DELIBERATELY DOES NOT ASSERT. Not that the manifest matches the
 * App Store Connect questionnaire item for item — they are different
 * taxonomies (the questionnaire covers third-party partners; this file need
 * not duplicate what an embedded SDK's own manifest declares), so a test
 * pinning them to each other would pin a false equivalence. The agreement
 * that matters is with the DATA INVENTORY, and that is what the type list
 * below encodes.
 *
 * Adding a data type to the service means adding it here. That is the point.
 */
// `require` rather than `import`, and `declare` rather than @types/node: the
// app's tsconfig carries `types: ["jest"]` only, so node's modules and
// `__dirname` are absent from the type environment even though they exist at
// runtime under Jest. Same idiom as messaging.groups.receive.test.ts, which
// reads a schema file the same way.
const { readFileSync } = require('fs') as {
  readFileSync: (path: string, encoding: string) => string;
};
const { join } = require('path') as { join: (...parts: string[]) => string };
declare const __dirname: string;

const MANIFEST = join(__dirname, '..', 'ios', 'Tacendum', 'PrivacyInfo.xcprivacy');

/**
 * Each entry traces to a row of the inventory's the design table:
 *   messages   -> tacendum_messages, 30-day TTL
 *   photos     -> S3 attachments, 30-day lifecycle
 *   audio      -> same blob path, voice notes
 *   user id    -> tacendum_users, the account IS the keypair (rows 1-3)
 *   device id  -> tacendum_push_tokens, APNs + VoIP tokens
 *   diagnostic -> S3 access logs (requester IP) + CloudWatch (rows 12-13)
 *   product    -> tacendum_activity, sha256(userId) hourly buckets
 */
const REQUIRED_TYPES = [
  'NSPrivacyCollectedDataTypeEmailsOrTextMessages',
  'NSPrivacyCollectedDataTypePhotosorVideos',
  'NSPrivacyCollectedDataTypeAudioData',
  'NSPrivacyCollectedDataTypeUserID',
  'NSPrivacyCollectedDataTypeDeviceID',
  'NSPrivacyCollectedDataTypeOtherDiagnosticData',
  'NSPrivacyCollectedDataTypeProductInteraction',
  // Added with the call-metric reconciliation: setupMs is
  // published as CallSetupLatency, a latency measurement of an in-app
  // operation, which is what Apple names Performance Data. It is NOT
  // Other Diagnostic Data — that entry's own comment scopes it to
  // server-side logs that measure nothing about the product.
  'NSPrivacyCollectedDataTypePerformanceData',
  // Added deliberately: an email address the user CHOOSES
  // to link — transmitted for verification/recovery sends, retained as a
  // keyed scrambling on a claim row with its findability switch. It moved
  // here from MUST_NOT_APPEAR on purpose: the product changed shape, the
  // change was ruled, and the declaration follows the data. The
  // username needs no new type — it is a handle under UserID.
  'NSPrivacyCollectedDataTypeEmailAddress',
];

/**
 * Types whose presence would mean the product changed shape, not that the
 * declaration improved. The server holds no phone number (phone support is
 * not live), no display name or avatar (`UserRecord` has no such field —
 * profile data travels as ordinary encrypted messages), uploads no address
 * book, and never sees a location outside encrypted message content. If one
 * of these ever appears, the right response is to ask what shipped, not to
 * update the list. (EmailAddress left this list exactly that
 * way — asked, ruled, then moved.)
 */
const MUST_NOT_APPEAR = [
  'NSPrivacyCollectedDataTypeName',
  'NSPrivacyCollectedDataTypePhoneNumber',
  'NSPrivacyCollectedDataTypePhysicalAddress',
  'NSPrivacyCollectedDataTypeContacts',
  'NSPrivacyCollectedDataTypePreciseLocation',
  'NSPrivacyCollectedDataTypeCoarseLocation',
];

describe('PrivacyInfo.xcprivacy', () => {
  const xml = readFileSync(MANIFEST, 'utf8');

  it('declares collected data — the array is never empty', () => {
    // The literal an emptying edit produces. Checked directly so the failure
    // names the actual regression rather than a downstream symptom.
    expect(xml).not.toMatch(/<key>NSPrivacyCollectedDataTypes<\/key>\s*<array\s*\/>/);
    expect(xml).toContain('<key>NSPrivacyCollectedDataTypes</key>');
  });

  it.each(REQUIRED_TYPES)('declares %s', (type) => {
    expect(xml).toContain(`<string>${type}</string>`);
  });

  it.each(MUST_NOT_APPEAR)('does not declare %s', (type) => {
    expect(xml).not.toContain(`<string>${type}</string>`);
  });

  it('every declared type is linked to the user', () => {
    // Nothing collected here is anonymous. The activity row is the only
    // arguable case — it stores sha256(userId) — and it is declared linked
    // on purpose: the hash is re-derivable by anyone holding the userId, so
    // "not linked" would rest on an attacker's ignorance rather than on the
    // data. There is no `false` in this file's Linked keys, and a new one
    // would be a claim worth stopping on.
    const linkedFalse = xml.match(
      /<key>NSPrivacyCollectedDataTypeLinked<\/key>\s*<false\s*\/>/g,
    );
    expect(linkedFalse).toBeNull();
  });

  it('declares no tracking, at the top level and per type', () => {
    expect(xml).toMatch(/<key>NSPrivacyTracking<\/key>\s*<false\s*\/>/);
    const trackingTrue = xml.match(
      /<key>NSPrivacyCollectedDataTypeTracking<\/key>\s*<true\s*\/>/g,
    );
    expect(trackingTrue).toBeNull();
  });

  it('never ANSWERS the export-compliance question false — absent asks it, false lies', () => {
    // Corrected on the first real upload.
    //
    // This test used to require `true` in the binary, on the reasoning that
    // the key merely deferred the declaration. Measured otherwise: with
    // `true` present and no App Encryption Declaration yet existing in App
    // Store Connect, Apple's validator REFUSES the upload — "Invalid Export
    // Compliance Code … doesn't match the key value of the app's export
    // compliance documentation". The key was there to avoid a Missing
    // Compliance wait and instead blocked shipping entirely.
    //
    // So the key is ABSENT, and absence is not an answer: it routes the same
    // truthful answers (uses encryption: yes; beyond the OS's: yes; exempt:
    // no) to the App Store Connect questionnaire, which is where the
    // compliance code is issued. Both keys return together once it is.
    //
    // What this test pins now is the only thing that was ever load-bearing:
    // `false` must never appear. That would be a false statement on a
    // federal compliance surface, and it is the one value a well-meaning
    // "just make the upload go through" edit reaches for.
    const plist = readFileSync(
      join(__dirname, '..', 'ios', 'Tacendum', 'Info.plist'),
      'utf8',
    );
    expect(plist).not.toMatch(
      /<key>ITSAppUsesNonExemptEncryption<\/key>\s*<false\s*\/>/,
    );
    // And if it is declared at all, it is declared true — the state the app
    // returns to once App Store Connect issues the code.
    if (/<key>ITSAppUsesNonExemptEncryption<\/key>/.test(plist)) {
      expect(plist).toMatch(
        /<key>ITSAppUsesNonExemptEncryption<\/key>\s*<true\s*\/>/,
      );
    }
  });

  it('declares iPad in exactly the enabled shape — all four ~ipad orientations, iPhone untouched', () => {
    // This pin used to say "does not declare iPad — v1 ships iPhone only".
    // That cut was reversed deliberately, so the
    // pin flips to the enablement's exact shape rather than being deleted:
    // Apple reviews on what you declare, and the two quiet regressions from
    // here are a regenerated plist dropping the ~ipad array (iPad support
    // half-leaving) and the iPhone array absorbing the four orientations
    // (phones stay portrait-only by design). Exact-match on
    // both arrays — the same discipline as the plutil checks, because a
    // presence grep reads ANY nonempty array as declared.
    const plist = readFileSync(
      join(__dirname, '..', 'ios', 'Tacendum', 'Info.plist'),
      'utf8',
    );
    const orientations = (key: string): string[] => {
      const m = plist.match(
        new RegExp(`<key>${key}</key>\\s*<array>([\\s\\S]*?)</array>`),
      );
      if (!m) return [];
      return [...m[1].matchAll(/<string>([^<]+)<\/string>/g)].map(x => x[1]);
    };
    expect(orientations('UISupportedInterfaceOrientations')).toEqual([
      'UIInterfaceOrientationPortrait',
    ]);
    expect(orientations('UISupportedInterfaceOrientations~ipad').sort()).toEqual(
      [
        'UIInterfaceOrientationLandscapeLeft',
        'UIInterfaceOrientationLandscapeRight',
        'UIInterfaceOrientationPortrait',
        'UIInterfaceOrientationPortraitUpsideDown',
      ],
    );
    // Deprecated under the iOS 26 SDK; adding it is the "just lock it to
    // portrait" edit this pin forecloses.
    expect(plist).not.toContain('UIRequiresFullScreen');
  });

  it('keeps the required-reason API declarations', () => {
    // Unrelated to the collection block, and the reason this file existed
    // before it declared anything: removing these fails App Store processing.
    expect(xml).toContain('NSPrivacyAccessedAPICategoryFileTimestamp');
    expect(xml).toContain('NSPrivacyAccessedAPICategoryUserDefaults');
    expect(xml).toContain('NSPrivacyAccessedAPICategorySystemBootTime');
  });
});
