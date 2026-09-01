/**
 * THE NOTIFICATION'S SOUND, AND THE ONE SWITCH THAT MAY TAKE IT AWAY
 * ("notification sound when text comes in").
 *
 * Where the sound comes from: the server's alert `aps` carries
 * `sound: 'default'` (packages/server/src/push/apns.ts), and the extension
 * inherits it on the mutable copy — so every banner it delivers sounds
 * unless a line in NotificationService.swift takes the sound away. Three
 * lines may: the two continuation jails (a burst buzzes once), pinned in
 * nse.preview.contract.test.ts, and the owner's preference pinned here.
 *
 * The preference reaches the extension as a FILE in the App Group container
 * (`message-sound`, app/src/messageSound.ts) exactly as `preview-level`
 * does — the extension cannot reach the Keychain. Its fail direction is the
 * opposite of every other mirror's, and deliberately: a missing file reads
 * as ON, because the default is on and OFF can only ever subtract a sound
 * from a banner that would have had one. The privacy doctrine on record —
 * locked and duress states gain NO new signal — is satisfied by exactly
 * that asymmetry: nothing here can add a sound; it can only remove one.
 *
 * `NotificationService.swift` cannot run under jest, so — as
 * nse.blocked.suppress.test.ts pins its blocked branch — these are pins on
 * the artifact: the server's default, the policy reader's literal, and the
 * shape and position of the one preference line.
 */

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
const policy = readFileSync(
  join(__dirname, '../ios/TacendumNSE/PreviewPolicy.swift'),
  'utf8',
);
const apns = readFileSync(
  join(__dirname, '../../packages/server/src/push/apns.ts'),
  'utf8',
);

import { MESSAGE_SOUND_FILE } from '../src/messageSound';

describe('the message notification carries a sound', () => {
  it('the server\'s alert aps sets sound: default — the sound the extension inherits', () => {
    // The alert arm's `aps` block: from its opening brace to the `t:`
    // member that follows it (the payload the extension decrypts).
    const start = apns.indexOf('aps: {');
    const end = apns.indexOf('t: payload', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const alert = apns.slice(start, end);
    expect(alert).toContain("sound: 'default'");
    expect(alert).toContain("'mutable-content': 1");
  });

  it('the extension never SETS a sound — it only ever takes the default away', () => {
    // Every touch of `content.sound` in the file assigns nil. A line that
    // assigned `.default` or a named sound would be a line that could add a
    // signal to a banner the server sent silent, which nothing may do.
    const touches = swift.match(/content\.sound\s*=\s*[^\n]+/g) ?? [];
    expect(touches.length).toBeGreaterThan(0);
    for (const touch of touches) expect(touch).toMatch(/content\.sound\s*=\s*nil$/);
  });
});

describe('the owner\'s preference in the extension', () => {
  it('PreviewPolicy reads the same file the app writes, and only a literal "0" is off', () => {
    expect(policy).toContain('static func messageSound() -> Bool {');
    expect(policy).toContain(`return read("${MESSAGE_SOUND_FILE}") != "0"`);
    expect(MESSAGE_SOUND_FILE).toBe('message-sound');
  });

  it('the preference line is the literal shape, sits after the copy guard and before the badge, and reads nothing else', () => {
    const line = 'if !PreviewPolicy.messageSound() {\n      content.sound = nil\n    }';
    expect(swift.split(line)).toHaveLength(2);
    const at = swift.indexOf(line);
    // After the blocked drop (which delivers EMPTY content — nothing to
    // subtract) and after the copy guard (`content` must exist to mute),
    // before the badge and every preview decision: the sound is not a
    // preview and does not wait on the lease.
    expect(swift.indexOf('PreviewPolicy.blocked()')).toBeLessThan(at);
    expect(swift.indexOf('guard let content = mutable')).toBeLessThan(at);
    expect(at).toBeLessThan(swift.indexOf('BadgeCounter.incrementedBadge()'));
    expect(at).toBeLessThan(swift.indexOf('PreviewPolicy.armedAndWritable()'));
  });

  it('the blocked drop stays empty content — no sound to honour or to subtract', () => {
    const branch = swift.match(
      /PreviewPolicy\.blocked\(\)\.contains\(push\.from\)[\s\S]*?return\s*\}/,
    );
    expect(branch).not.toBeNull();
    expect(branch![0]).toContain('UNMutableNotificationContent()');
    expect(branch![0]).not.toMatch(/content\.sound/);
    expect(branch![0]).not.toMatch(/messageSound/);
  });
});
