/**
 * A BLOCKED SENDER'S ALERT PUSH MUST DIE WITHOUT A TRACE.
 *
 * Blocking is enforced on receipt and is deliberately undetectable to the
 * blocked party, so their ciphertext still earns a push. The NSE checked the
 * blocked-peers mirror before attributing anything — no preview, no badge,
 * no ratchet advance — but then delivered the server's fallback content,
 * which is a visible "Tacendum / New message" banner WITH the default sound
 * (packages/server/src/push/apns.ts, the alert `aps`). Every message a
 * blocked sender cared to fire was an audible ping on the victim's lock
 * screen: block someone and their harassment merely loses its byline.
 *
 * The platform's one sanctioned way for an extension to DROP an alert rather
 * than rewrite it is the filtering entitlement
 * (com.apple.developer.usernotifications.filtering) plus delivery of EMPTY
 * content — no title, no body, no sound. Never "just don't call the
 * handler": an extension that goes quiet gets its original push shown by the
 * system, which is worse.
 *
 * `NotificationService.swift` cannot run under jest, so — exactly as
 * nse.preview.contract.test.ts pins the classify transcript and
 * nse.mirror.test.ts pins the mirror bytes — these are pins on the artifact
 * itself: the entitlement key the build signs with, and the literal shape of
 * the blocked branch. Editing either is meant to be a conscious act that
 * lands here first; the device row for this behavior stays a comparison, not
 * an investigation.
 */

// `require` rather than `import`, and `declare` rather than @types/node: the
// app's tsconfig carries `types: ["jest"]` only, so node's modules and
// `__dirname` are absent from the type environment even though they exist at
// runtime under Jest. Same idiom as privacy.manifest.test.ts, which pins an
// ios/ artifact the same way. The bare export makes this file a MODULE, so
// its declarations stay its own — as a script they would collide with that
// file's copies of the very same names.
export {};
const { readFileSync } = require('fs') as {
  readFileSync: (path: string, encoding: string) => string;
};
const { join } = require('path') as { join: (...parts: string[]) => string };
declare const __dirname: string;

const swift = readFileSync(
  join(__dirname, '../ios/TacendumNSE/NotificationService.swift'),
  'utf8',
);
const entitlements = readFileSync(
  join(__dirname, '../ios/TacendumNSE/TacendumNSE.entitlements'),
  'utf8',
);

describe('the blocked-sender guard in the NSE', () => {
  it('records the filtering entitlement as REMOVED pending Apple\'s grant', () => {
    // Found on a real archive: the App Store archive failed on this key — the capability
    // needs Apple's approval, the request is filed, and shipping was chosen
    // over waiting (the entitlements file carries the full note). Until the
    // grant lands, empty content still PRESENTS a soundless, textless
    // app-name banner; with the key it would present nothing. This pin held
    // the key in place before; it now holds the interim state in place —
    // re-adding the key must flip this test back to `toContain`, so the
    // return is as conscious as the removal was.
    expect(entitlements).not.toContain(
      'com.apple.developer.usernotifications.filtering',
    );
    // The story must survive even while the key is gone: the file keeps the
    // distribution note explaining what returns and why.
    expect(entitlements).toContain('the key is REMOVED');
  });

  it('delivers EMPTY content on the blocked path, never the generic banner', () => {
    // The branch as text, from the mirror check to its return. The falsifying
    // case is HEAD before this fix: `deliver(content)` — the server's
    // "New message" plus sound, for a sender the owner explicitly refused.
    const branch = swift.match(
      /PreviewPolicy\.blocked\(\)\.contains\(push\.from\)[\s\S]*?return\s*\}/,
    );
    expect(branch).not.toBeNull();
    expect(branch![0]).toContain('UNMutableNotificationContent()');
    expect(branch![0]).not.toContain('deliver(content)');
    // And the expiry fallback is replaced BEFORE the handoff, so
    // serviceExtensionTimeWillExpire racing this branch cannot resurrect the
    // banner the verdict just refused.
    expect(branch![0]).toContain('fallback =');
  });

  it('decides blocked before the badge and before the copy guard', () => {
    // Order is the contract: a blocked sender's mail must not tick the badge
    // (their existence must stay invisible), and the check must not sit
    // behind `mutableCopy` — a copy failure is not permission to attribute.
    const blockedAt = swift.indexOf('PreviewPolicy.blocked()');
    const badgeAt = swift.indexOf('BadgeCounter.incrementedBadge()');
    const copyGuardAt = swift.indexOf('guard let content = mutable');
    expect(blockedAt).toBeGreaterThan(-1);
    expect(badgeAt).toBeGreaterThan(-1);
    expect(copyGuardAt).toBeGreaterThan(-1);
    expect(blockedAt).toBeLessThan(badgeAt);
    expect(blockedAt).toBeLessThan(copyGuardAt);
  });
});
