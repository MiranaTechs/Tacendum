/**
 * The device-naming copy pass, pinned per-platform at the deck level.
 *
 * The pure copy decks — blocking, safety, vault, reporting — evaluate their
 * Platform branch at module load, so this suite runs the REAL modules under
 * an Android Platform and asserts the Android sentences exactly. The iOS
 * sentences stay pinned where they always were (blocking.test.ts,
 * vault.copy.test.ts, safety.test.ts run under jest's default iOS Platform);
 * this file is their Android mirror, plus the sweep the divergences doc
 * promises: no Android-worded deck string says iPhone, iCloud or Apple.
 */

jest.mock('react-native/Libraries/Utilities/Platform', () => ({
  __esModule: true,
  default: {
    OS: 'android',
    select: (spec: Record<string, unknown>) =>
      'android' in spec
        ? spec.android
        : 'native' in spec
          ? spec.native
          : spec.default,
    Version: 35,
    isTesting: true,
  },
}));

// A PHONE's screen, explicitly: the decks now resolve the device noun
// through deviceNoun.ts, which on Android reads the SCREEN's smaller
// dimension against the sw600dp cut — and the preset's default Dimensions
// mock (750×1334) would classify as a tablet. This suite pins the
// android-PHONE sentences; the tablet renderings are pinned per-idiom in
// device-noun.test.ts.
jest.mock('react-native/Libraries/Utilities/Dimensions', () => ({
  __esModule: true,
  default: {
    get: () => ({ width: 393, height: 852, scale: 3, fontScale: 1 }),
    set: jest.fn(),
    addEventListener: jest.fn(() => ({ remove: jest.fn() })),
  },
}));

import { BLOCK_COPY, BLOCK_EXPLAINER } from '../src/blocking';
import { REPORT_COPY } from '../src/reporting';
import { SAFETY_COPY } from '../src/safety';
import { VAULT_CONSEQUENCE, VAULT_LIMITS } from '../src/vault';

describe('the blocking deck speaks Android', () => {
  it('names the device "this phone" in every sentence that names it', () => {
    expect(BLOCK_EXPLAINER[0]).toBe(
      'Blocking is a setting on this phone. They are never told, and nothing about their app changes.',
    );
    expect(BLOCK_COPY.statusLabel).toBe('Blocked on this phone');
    expect(BLOCK_COPY.confirmQuestion).toBe('Block them on this phone?');
    expect(BLOCK_COPY.bannerAnnounce).toBe(
      'The composer is closed. You blocked this person on this phone.',
    );
    expect(BLOCK_COPY.blockedAnnounce).toBe(
      'Blocked. Their messages will be discarded on this phone.',
    );
  });

  it('omits "no screenshot notices" — on Android there is no such notice to withhold', () => {
    expect(BLOCK_EXPLAINER[2]).toBe(
      'While they are blocked, this phone sends them nothing: no replies, no delivery or read marks, no reactions, no calls. To them the room looks like one where you stopped replying.',
    );
    expect(BLOCK_EXPLAINER[2]).not.toContain('screenshot');
  });
});

describe('the safety deck speaks Android', () => {
  it('the matched disclosure and the mismatch label name this phone', () => {
    expect(SAFETY_COPY.matched.disclosure!('Ada')).toBe(
      'Only this phone remembers this. Ada isn’t told, and nothing changes about how your messages are sent.',
    );
    expect(SAFETY_COPY.mismatched.label).toBe('Did not match on this phone');
  });
});

describe('the vault deck speaks Android', () => {
  it('the Copy consequence names the clipboard and its real leak paths — never an iCloud analogue', () => {
    // "some devices sync", not "some phones sync": the leak-path warning
    // is about THIS user's hardware, and a Galaxy Tab syncs its clipboard too.
    expect(VAULT_CONSEQUENCE[1]).toBe(
      'Copy puts the value on the clipboard, where the keyboard and the app you paste into can read it — and some devices sync the clipboard to your other devices. Tacendum clears it a minute later.',
    );
  });

  it('the limits name this phone and drop the iOS paste prompt (Android never asks — it silently withholds)', () => {
    expect(VAULT_LIMITS[0]).toContain('same lock on this phone');
    expect(VAULT_LIMITS[1]).toContain('If this phone is lost the vault goes with it');
    expect(VAULT_LIMITS[4]).toBe(
      'Clearing the clipboard checks what is on it first, so it never wipes something you copied in the meantime. If you copied something else since, that check cannot see it and nothing is cleared: the newer value stays where you put it.',
    );
  });
});

describe('the reporting deck speaks Android', () => {
  it('the failure sentence keeps its guarantee, in the platform’s words', () => {
    expect(REPORT_COPY.failed).toBe(
      'The report was not sent. Nothing left your phone — try again.',
    );
  });
});

describe('the sweep the divergences doc promises', () => {
  it('no Android-worded deck string says iPhone, iCloud, Apple or pasteboard', () => {
    const all: string[] = [
      ...BLOCK_EXPLAINER,
      ...(Object.values(BLOCK_COPY) as unknown[]).filter(
        (v): v is string => typeof v === 'string',
      ),
      ...VAULT_CONSEQUENCE,
      ...VAULT_LIMITS,
      ...(Object.values(REPORT_COPY) as unknown[]).filter(
        (v): v is string => typeof v === 'string',
      ),
      ...Object.values(SAFETY_COPY).flatMap(state =>
        [state.label, state.title, state.action, state.followUp].filter(
          (v): v is string => typeof v === 'string',
        ),
      ),
      SAFETY_COPY.matched.disclosure!('Ada'),
    ];
    expect(all.length).toBeGreaterThan(20); // the sweep really swept
    for (const s of all) {
      expect(s).not.toMatch(/iphone|icloud|apple|pasteboard/i);
    }
  });
});
