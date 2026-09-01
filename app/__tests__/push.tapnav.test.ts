/**
 * THE BANNER TAP: from a notification to the thread,
 * with the duress boundary intact.
 *
 * The whole mechanism, so the pins below read as one story:
 *
 *   1. AppDelegate's `didReceive(response:)` — the platform's DEFAULT tap
 *      action only — writes ONE line, "<unix-ms> <threadIdentifier>", to the
 *      shared container ('pending-nav'). The threadIdentifier is a row key
 *      the NSE minted from the address the decrypt succeeded against: a bare
 *      26-char id for a 1:1, "g/" + one for a room. Nothing else crosses —
 *      not userInfo, not a rendered line, not a name.
 *   2. The app then launches or foregrounds through its ORDINARY flow —
 *      lock.ts's verdict included, which the tap path cannot see and never
 *      anticipates. Nothing here bypasses or special-cases the lock.
 *   3. `consumePendingNav` (src/pushnav.ts) redeems the intent ONLY where a
 *      REAL workspace already opened: after `enterRealWorkspace` routed to
 *      chats, and on the foreground edge under the same
 *      `session.mode === 'real'` gate the socket resume uses. The decoy arm
 *      consumes it UNREAD — a tap must not decorate the decoy with a thread
 *      its database cannot explain, and must not outlive the coerced
 *      session to teleport a later real unlock.
 *
 * THE VERDICT THIS FILE ENFORCES (the adopted design): NO banner
 * answer actions, NO categories, ever — device unlock cannot distinguish
 * the duress passcode from the real one, because that comparison exists
 * only inside lock.ts. The only affordance is the tap. And NO URL scheme,
 * NO deep link: navigation rides notification identifiers and in-process
 * plumbing only (the qr-bare-id guardrail applies to every entry surface).
 */

import * as crypto from 'tacendum-crypto';
import {
  consumePendingNav,
  PENDING_NAV_FILE,
  PENDING_NAV_TTL_MS,
} from '../src/pushnav';

// `require` rather than `import`, exactly as nse.preview.contract.test.ts
// pins ios/ artifacts: the app tsconfig carries `types: ["jest"]` only.
const { readFileSync, readdirSync } = require('fs') as {
  readFileSync: (path: string, encoding: string) => string;
  readdirSync: (path: string) => string[];
};
const { join } = require('path') as { join: (...parts: string[]) => string };
declare const __dirname: string;
const artifact = (rel: string) => readFileSync(join(__dirname, rel), 'utf8');

/** The classic canonical ULID — Crockford alphabet, no I/L/O/U. */
const ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

const shared = (crypto as unknown as { __sharedState: Map<string, string> })
  .__sharedState;

describe('consumePendingNav: the intent redeems once, as a row key, or not at all', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    shared.clear();
  });

  it('a fresh 1:1 intent redeems to the bare peer id and is consumed', async () => {
    const now = Date.now();
    shared.set(PENDING_NAV_FILE, `${now} ${ULID}`);
    await expect(consumePendingNav(now)).resolves.toBe(ULID);
    expect(shared.has(PENDING_NAV_FILE)).toBe(false);
  });

  it('a room intent strips the g/ prefix — a room\'s conversation row IS its ULID', async () => {
    const now = Date.now();
    shared.set(PENDING_NAV_FILE, `${now} g/${ULID}`);
    await expect(consumePendingNav(now)).resolves.toBe(ULID);
    expect(shared.has(PENDING_NAV_FILE)).toBe(false);
  });

  it('whatever comes out is ULID-shaped — the intent cannot carry approval content, by construction', async () => {
    const now = Date.now();
    shared.set(PENDING_NAV_FILE, `${now} ${ULID}`);
    const out = await consumePendingNav(now);
    expect(out).not.toBeNull();
    expect(/^[0-9A-HJKMNP-TV-Z]{26}$/.test(out!)).toBe(true);
  });

  it('a stale tap opens the app like any other launch: past the TTL, null — and still consumed', async () => {
    const now = Date.now();
    shared.set(PENDING_NAV_FILE, `${now - PENDING_NAV_TTL_MS - 1} ${ULID}`);
    await expect(consumePendingNav(now)).resolves.toBeNull();
    expect(shared.has(PENDING_NAV_FILE)).toBe(false);
  });

  it('a timestamp from the future beyond clock wobble is corruption, not a tap — null, consumed', async () => {
    const now = Date.now();
    shared.set(PENDING_NAV_FILE, `${now + 61_000} ${ULID}`);
    await expect(consumePendingNav(now)).resolves.toBeNull();
    expect(shared.has(PENDING_NAV_FILE)).toBe(false);
    // A small wobble is a tap: clocks are not oracles.
    shared.set(PENDING_NAV_FILE, `${now + 30_000} ${ULID}`);
    await expect(consumePendingNav(now)).resolves.toBe(ULID);
  });

  it('anything that is not the one line Swift writes is not an intent — each variant null, each consumed', async () => {
    const now = Date.now();
    // ('' is not here: the native contract reads an ABSENT file as '', so
    // empty is the absent case, covered above — nothing exists to consume.)
    const junk = [
      `${now} ${ULID.toLowerCase()}`, // folding tolerance is for humans; a machine-minted key gets none
      `${now} ${ULID.slice(0, 25)}`, // short
      `${now} ${ULID}Z`, // long
      `${now} 01ILOU3NDEKTSV4RRFFQ69G5FA`, // outside the Crockford alphabet
      `${now} h/${ULID}`, // an unknown prefix is not a room
      `${now} tacendum://thread/${ULID}`, // a URL is not an intent, ever
      `${now} {"tcm":"x.approval","q":"${ULID}"}`, // an envelope is not an intent
      `${ULID}`, // no timestamp
      `${now}  ${ULID}`, // two spaces — not the format
    ];
    for (const line of junk) {
      shared.set(PENDING_NAV_FILE, line);
      await expect(consumePendingNav(now)).resolves.toBeNull();
      expect(shared.has(PENDING_NAV_FILE)).toBe(false);
    }
  });

  it('absent means absent: no file, null, nothing thrown', async () => {
    await expect(consumePendingNav()).resolves.toBeNull();
  });

  it('a read failure is a lost tap, never a thrown unlock', async () => {
    (crypto.readSharedState as jest.Mock).mockRejectedValueOnce(
      new Error('container unavailable'),
    );
    await expect(consumePendingNav()).resolves.toBeNull();
  });

  it('an intent that cannot be CONSUMED does not navigate — a tap that fires on every unlock forever is worse than a lost one', async () => {
    const now = Date.now();
    shared.set(PENDING_NAV_FILE, `${now} ${ULID}`);
    (crypto.deleteSharedState as jest.Mock).mockRejectedValueOnce(
      new Error('container unavailable'),
    );
    await expect(consumePendingNav(now)).resolves.toBeNull();
  });
});

describe('the native half: the tap writes a row key and nothing else', () => {
  let appDelegate = '';
  beforeAll(() => {
    appDelegate = artifact('../ios/Tacendum/AppDelegate.swift');
  });

  it('didReceive(response:) exists, honours ONLY the platform default tap, and reads only the threadIdentifier', () => {
    expect(appDelegate).toContain(
      'didReceive response: UNNotificationResponse',
    );
    expect(appDelegate).toContain('UNNotificationDefaultActionIdentifier');
    expect(appDelegate).toContain(
      'response.notification.request.content.threadIdentifier',
    );
    // Row keys only: the payload mirror, the rendered body and the title
    // never cross. `userInfo` appearing anywhere in this file would be the
    // first byte of a leak.
    expect(appDelegate).not.toMatch(/userInfo/);
    expect(appDelegate).not.toMatch(/\.body\b/);
    expect(appDelegate).not.toMatch(/\.title\b/);
  });

  it('the shape guard accepts exactly the two shapes the NSE mints', () => {
    // A bare 26-char id or "g/" + one; anything else navigates nowhere. The
    // guard is the same launder CollapseCounter applies to its key.
    expect(appDelegate).toContain(
      'let key = thread.hasPrefix("g/") ? String(thread.dropFirst(2)) : thread',
    );
    expect(appDelegate).toContain('key.count == 26');
    expect(appDelegate).toContain(
      'key.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) })',
    );
  });

  it('the intent file rides the shared-state conventions: name, directory, protection class, atomic write', () => {
    expect(appDelegate).toContain('"pending-nav"');
    expect(appDelegate).toContain('"tacendum-shared"');
    expect(appDelegate).toContain(
      'FileProtectionType.completeUntilFirstUserAuthentication',
    );
    expect(appDelegate).toContain(
      '.completeFileProtectionUntilFirstUserAuthentication',
    );
    expect(appDelegate).toContain('.atomic');
  });

  it('one fact in two languages, three times over: the file name, the app group, the directory', () => {
    const sharedContainer = artifact(
      '../modules/tacendum-crypto/ios/SharedContainer.swift',
    );
    const pushnav = artifact('../src/pushnav.ts');
    // The file name: Swift writes it, TS consumes it.
    expect(pushnav).toContain("'pending-nav'");
    // The app group: AppDelegate sees SharedContainer only across the pod
    // boundary, so the literal is duplicated and held together here.
    const groupOf = (src: string) =>
      src.match(/appGroupIdentifier = "([^"]+)"/)?.[1];
    expect(groupOf(appDelegate)).toBeDefined();
    expect(groupOf(appDelegate)).toBe(groupOf(sharedContainer));
    // The directory: the same 'tacendum-shared' TacendumCryptoImpl owns.
    expect(sharedContainer).toContain('"tacendum-shared"');
  });

  it('the writer/consumer split holds: Swift writes, TS only reads and deletes', () => {
    const pushnav = artifact('../src/pushnav.ts');
    expect(pushnav).not.toMatch(/writeSharedState/);
    expect(pushnav).toContain('readSharedState');
    expect(pushnav).toContain('deleteSharedState');
    // And the consumer's alphabet is peerId.ts's CANON, restated because
    // that regex is not exported — held together here so neither drifts.
    const peerId = artifact('../src/peerId.ts');
    expect(peerId).toContain('/^[0-9A-HJKMNP-TV-Z]{26}$/');
    expect(pushnav).toContain('[0-9A-HJKMNP-TV-Z]{26}');
  });
});

describe('the verdict pins: no categories, no actions, no URL scheme — the tap is the only affordance', () => {
  const iosSources = (): string[] => {
    // Every Swift/ObjC source in both app targets and every native module —
    // a category registered ANYWHERE would arm banner buttons.
    const roots = [
      '../ios/Tacendum',
      '../ios/TacendumNSE',
      ...readdirSync(join(__dirname, '../modules')).map(
        m => `../modules/${m}/ios`,
      ),
    ];
    const files: string[] = [];
    for (const root of roots) {
      let entries: string[] = [];
      try {
        entries = readdirSync(join(__dirname, root));
      } catch {
        continue; // a module without an ios/ directory
      }
      for (const entry of entries) {
        if (/\.(swift|mm|m|h)$/.test(entry)) files.push(`${root}/${entry}`);
      }
    }
    return files;
  };

  it('no notification category or action is registered in any native source (mutation (ii) lands here)', () => {
    const sources = iosSources();
    // Non-vacuous: the scan must at least be reading the two files this
    // phase touched.
    expect(sources).toEqual(
      expect.arrayContaining([
        '../ios/Tacendum/AppDelegate.swift',
        '../ios/TacendumNSE/NotificationService.swift',
      ]),
    );
    for (const rel of sources) {
      expect(artifact(rel)).not.toMatch(
        /UNNotificationCategory|UNNotificationAction|UNTextInputNotificationAction|setNotificationCategories|categoryIdentifier/,
      );
    }
  });

  it('no URL scheme, either target, and no Linking listener in the router — the qr-bare-id guardrail holds', () => {
    expect(artifact('../ios/Tacendum/Info.plist')).not.toContain(
      'CFBundleURLTypes',
    );
    expect(artifact('../ios/TacendumNSE/Info.plist')).not.toContain(
      'CFBundleURLTypes',
    );
    const appDelegate = artifact('../ios/Tacendum/AppDelegate.swift');
    expect(appDelegate).not.toMatch(/openURL|open url|CFBundleURLTypes/);
    expect(artifact('../App.tsx')).not.toMatch(/\bLinking\b/);
    expect(artifact('../src/pushnav.ts')).not.toMatch(/\bLinking\b/);
  });
});

describe('the redemption sits where the verdict already ruled (App.tsx)', () => {
  let appTsx = '';
  beforeAll(() => {
    appTsx = artifact('../App.tsx');
  });

  it('the real arm redeems AFTER routing to chats — the tap survives the unlock without touching it', () => {
    // enterRealWorkspace: chats first (so Back lands where it always
    // lands), then the intent. The order is the pin: a redemption above the
    // route would race the workspace open.
    const at = appTsx.indexOf('const tapped = await consumePendingNav();');
    expect(at).toBeGreaterThan(-1);
    expect(appTsx).toContain(
      "if (tapped) setRoute({ name: 'thread', peerId: tapped });",
    );
    const chatsAt = appTsx.indexOf("setRoute({ name: 'chats' });");
    expect(chatsAt).toBeGreaterThan(-1);
    expect(chatsAt).toBeLessThan(at);
  });

  it('the decoy arm consumes the intent UNREAD: no navigation, and nothing left to teleport a later unlock', () => {
    const decoy = appTsx.match(
      /const enterDecoyWorkspace = useCallback\(async \([^)]*\) => \{[\s\S]*?\n {2}\}, \[[^\]]*\]\);/,
    );
    expect(decoy).not.toBeNull();
    expect(decoy![0]).toContain('void consumePendingNav();');
    // The decoy never routes to a thread, tap or no tap.
    expect(decoy![0]).not.toMatch(/name: 'thread'/);
  });

  it('the foreground redemption rides the same real-session gate as the socket resume', () => {
    const gate = appTsx.match(
      /if \(session\.mode === 'real' && current !== 'locked' && current !== 'loading'\) \{[\s\S]*?consumePendingNav[\s\S]*?\n {10}\}/,
    );
    expect(gate).not.toBeNull();
    // And only from a surface a tap may be consumed on. Updated
    // deliberately: the landing/register exclusion moved from route-name
    // strings (`current !== 'landing' && current !== 'register'`) into the
    // visible-surface model's `pushNavRedeemable` fact — same behavior,
    // pinned by visible-surface.test.ts's matrix. (This pin encoded the
    // pre-extraction SHAPE, not the defect; the design is the capture cover
    // and does not touch this path.)
    expect(gate![0]).toContain('surfaceFactsRef.current.pushNavRedeemable');
    // The landing gate rides the model too: a redemption resolving after a
    // relock must wait for the unlock arm.
    expect(gate![0]).toContain('surfaceFactsRef.current.pushNavLandable');
  });

  it('the tap path never touches the lock: pushnav imports no lock, no session, no db', () => {
    const pushnav = artifact('../src/pushnav.ts');
    expect(pushnav).not.toMatch(/from '\.\/lock'/);
    expect(pushnav).not.toMatch(/from '\.\/session'/);
    expect(pushnav).not.toMatch(/from '\.\/db'/);
    // Its only imports are the shared-state pair: the intent file is the
    // entire surface.
    expect(pushnav).toContain(
      "import { deleteSharedState, readSharedState } from 'tacendum-crypto';",
    );
  });
});
