/**
 * THE DEVICE-NOUN TOKEN, PER PLATFORM AND PER IDIOM.
 *
 * Three things this suite holds:
 *
 *  1. THE RESOLUTION TABLE. `DEVICE_NOUN` answers the platform's own word
 *     for the device it is running on: iOS resolves by interface idiom
 *     (iPhone/iPad), Android by the sw600dp cut over the SCREEN's smaller
 *     dimension (phone/tablet), anything else "device". Boundary (599/600)
 *     and rotation (width/height swapped) cases included — the noun is
 *     idiom-driven, never window-driven, so rotation must change nothing.
 *
 *  2. CONSENT-GRADE RENDERINGS, per idiom. The pure copy decks evaluate the
 *     token at module load, so each idiom loads them fresh under its own
 *     Platform/Dimensions and pins the exact sentence a person on that
 *     device reads. iPhone renderings are byte-identical to what shipped
 *     (RegisterScreen.test.tsx and the iOS deck suites still pin those under
 *     jest's default Platform); android-phone renderings are byte-identical
 *     to the first device-naming pass with ONE deliberate exception — vault.ts
 *     `VAULT_CONSEQUENCE[1]` widened "some phones sync the clipboard" to
 *     "some devices sync the clipboard" (phone or tablet alike; its row in
 *     the divergence inventory records it, and
 *     android.copy.decks.test.ts pins the new bytes) — and
 *     android.copy.decks.test.ts still pins the rest verbatim;
 *     iPad and android-tablet are the newly reachable renderings.
 *
 *  3. THE ALLOWLIST. The word "iPhone" may remain in app/src only where a
 *     row below says so — deviceNoun.ts (the token's own values) and one
 *     deliberate comment. A grep-level scan, comments included, because the
 *     Verify gate is about OCCURRENCES: any new "iPhone" anywhere in the
 *     production tree must either become the token or earn an allowlist row
 *     in this file, reviewably. Two-way: a stale allowlist row fails too.
 */

export {};

const { readFileSync, readdirSync, statSync } = require('fs') as {
  readFileSync: (path: string, encoding: string) => string;
  readdirSync: (path: string) => string[];
  statSync: (path: string) => { isDirectory: () => boolean };
};
const { join, relative } = require('path') as {
  join: (...parts: string[]) => string;
  relative: (from: string, to: string) => string;
};
declare const __dirname: string;

const APP_ROOT = join(__dirname, '..');

/* ────────────────────────────────────────────────────────────────────────
 * Per-idiom module loading. The decks read Platform and Dimensions once, at
 * module load, so each case resets the registry and mocks both before
 * requiring the modules under test.
 * ──────────────────────────────────────────────────────────────────────── */

interface Idiom {
  os: 'ios' | 'android' | 'windows';
  isPad?: boolean;
  /** Android's SCREEN dims in dp; ignored on iOS by construction. */
  screen?: { width: number; height: number };
}

function loadUnder<T>(idiom: Idiom, load: () => T): T {
  let out: T;
  jest.isolateModules(() => {
    jest.doMock('react-native/Libraries/Utilities/Platform', () => ({
      __esModule: true,
      default: {
        OS: idiom.os,
        isPad: idiom.isPad ?? false,
        select: (spec: Record<string, unknown>) =>
          idiom.os in spec
            ? spec[idiom.os]
            : 'native' in spec
              ? spec.native
              : spec.default,
        Version: idiom.os === 'android' ? 35 : '26.0',
        isTesting: true,
      },
    }));
    jest.doMock('react-native/Libraries/Utilities/Dimensions', () => ({
      __esModule: true,
      default: {
        get: () => ({
          ...(idiom.screen ?? { width: 393, height: 852 }),
          scale: 3,
          fontScale: 1,
        }),
        set: jest.fn(),
        addEventListener: jest.fn(() => ({ remove: jest.fn() })),
      },
    }));
    out = load();
  });
  jest.dontMock('react-native/Libraries/Utilities/Platform');
  jest.dontMock('react-native/Libraries/Utilities/Dimensions');
  return out!;
}

const nounUnder = (idiom: Idiom): string =>
  loadUnder(idiom, () => require('../src/deviceNoun').DEVICE_NOUN as string);

describe('the resolution table (idiom-driven, never window-driven)', () => {
  it('iOS resolves by interface idiom', () => {
    expect(nounUnder({ os: 'ios', isPad: false })).toBe('iPhone');
    expect(nounUnder({ os: 'ios', isPad: true })).toBe('iPad');
  });

  it('iOS ignores screen size entirely — a tablet-sized window is not an iPad', () => {
    expect(
      nounUnder({ os: 'ios', isPad: false, screen: { width: 1024, height: 1366 } }),
    ).toBe('iPhone');
  });

  it('Android resolves by the sw600dp cut, exactly at the boundary', () => {
    expect(nounUnder({ os: 'android', screen: { width: 393, height: 852 } })).toBe('phone');
    expect(nounUnder({ os: 'android', screen: { width: 599, height: 960 } })).toBe('phone');
    expect(nounUnder({ os: 'android', screen: { width: 600, height: 960 } })).toBe('tablet');
    expect(nounUnder({ os: 'android', screen: { width: 800, height: 1280 } })).toBe('tablet');
  });

  it('rotation changes nothing: the smaller dimension decides', () => {
    expect(nounUnder({ os: 'android', screen: { width: 1280, height: 800 } })).toBe('tablet');
    expect(nounUnder({ os: 'android', screen: { width: 852, height: 393 } })).toBe('phone');
  });

  it('an unshipped platform gets the noun that is never wrong', () => {
    expect(nounUnder({ os: 'windows' })).toBe('device');
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * Consent-grade renderings per idiom, from the real deck modules.
 * ──────────────────────────────────────────────────────────────────────── */

interface Decks {
  BLOCK_COPY: { statusLabel: string; confirmQuestion: string };
  BLOCK_EXPLAINER: string[];
  SAFETY_COPY: { mismatched: { label: string } };
  VAULT_LIMITS: string[];
  REPORT_COPY: { failed: string };
  LINKING_COPY: {
    codeInstruction: string;
    notPristine: string;
    verificationLocal: string;
    historyStance: string;
    classMismatch: string;
    slotAssertion: (slot: string) => string;
    settingsRow: string;
  };
  ACCOUNTS_COPY: {
    emailIntro: string;
    downgradeIntro: string;
    recoverNeedsIdentity: string;
    recoverScope: string;
    discoverNoMatch: string;
    settingsRow: string;
    emailCodeSent: (address: string) => string;
    emailCodeBudget: string[];
  };
  ACCOUNTS_PHONE_COPY: {
    numberIntro: string;
    discoverableExplain: string[];
    discoverNoMatchNumber: string;
    recoverScopeBoth: string;
    settingsRow: string;
    numberUnlinkKeep: string;
    numberCodeSent: (number: string) => string;
    numberCodeBudget: string[];
    smsConsentLabel: string;
  };
}

const decksUnder = (idiom: Idiom): Decks =>
  loadUnder(idiom, () => {
    const blocking = require('../src/blocking');
    const safety = require('../src/safety');
    const vault = require('../src/vault');
    const reporting = require('../src/reporting');
    // The linking deck — pure like the
    // others, loaded fresh per idiom for the same reason.
    const linking = require('../src/linkingCopy');
    // The identifier/discovery/recovery deck —
    // the same discipline, same per-idiom load.
    const accountsCopy = require('../src/accountsCopy');
    // The PHONE deck — AccountPhoneScreen's sibling deck, loaded per
    // idiom exactly like the rest (the surfaces reading it are dark behind
    // PHONE_UI_ENABLED, but the deck's sentences are pinned regardless: a
    // hardcoded noun must fail BEFORE the pin ever flips).
    const accountsPhoneCopy = require('../src/accountsPhoneCopy');
    return {
      BLOCK_COPY: blocking.BLOCK_COPY,
      BLOCK_EXPLAINER: blocking.BLOCK_EXPLAINER,
      SAFETY_COPY: safety.SAFETY_COPY,
      VAULT_LIMITS: vault.VAULT_LIMITS,
      REPORT_COPY: reporting.REPORT_COPY,
      LINKING_COPY: linking.LINKING_COPY,
      ACCOUNTS_COPY: accountsCopy.ACCOUNTS_COPY,
      ACCOUNTS_PHONE_COPY: accountsPhoneCopy.ACCOUNTS_PHONE_COPY,
    };
  });

describe('consent-grade renderings, per idiom', () => {
  it('iPhone: byte-identical to the shipped iOS sentences', () => {
    const d = decksUnder({ os: 'ios', isPad: false });
    expect(d.BLOCK_COPY.statusLabel).toBe('Blocked on this iPhone');
    expect(d.SAFETY_COPY.mismatched.label).toBe('Did not match on this iPhone');
    expect(d.VAULT_LIMITS[1]).toBe(
      'It is not a password manager. Nothing fills in for you, nothing watches for breaches, and there is no separate password. If this iPhone is lost the vault goes with it; there is no recovery key.',
    );
    expect(d.REPORT_COPY.failed).toBe(
      'The report was not sent. Nothing left your iPhone — try again.',
    );
    // The iOS substance arm keeps its screenshot-notice clause.
    expect(d.BLOCK_EXPLAINER[2]).toBe(
      'While they are blocked, this iPhone sends them nothing: no replies, no delivery or read marks, no reactions, no screenshot notices, no calls. To them the chat looks like one where you stopped replying.',
    );
  });

  it('iPad: the same sentences name the device truthfully', () => {
    const d = decksUnder({ os: 'ios', isPad: true });
    expect(d.BLOCK_COPY.statusLabel).toBe('Blocked on this iPad');
    expect(d.BLOCK_COPY.confirmQuestion).toBe('Block them on this iPad?');
    expect(d.SAFETY_COPY.mismatched.label).toBe('Did not match on this iPad');
    expect(d.VAULT_LIMITS[1]).toContain(
      'If this iPad is lost the vault goes with it; there is no recovery key.',
    );
    expect(d.REPORT_COPY.failed).toBe(
      'The report was not sent. Nothing left your iPad — try again.',
    );
    // Same idiom family, same substance arm: iPads disclose screenshots too.
    expect(d.BLOCK_EXPLAINER[2]).toContain(
      'this iPad sends them nothing: no replies, no delivery or read marks, no reactions, no screenshot notices, no calls.',
    );
  });

  it('Android phone: byte-identical to the first device-naming pass', () => {
    const d = decksUnder({ os: 'android', screen: { width: 393, height: 852 } });
    expect(d.BLOCK_COPY.statusLabel).toBe('Blocked on this phone');
    expect(d.SAFETY_COPY.mismatched.label).toBe('Did not match on this phone');
    expect(d.REPORT_COPY.failed).toBe(
      'The report was not sent. Nothing left your phone — try again.',
    );
  });

  /* The linking deck, per idiom (new
   * consent-grade copy EXTENDS this suite rather than regressing it).
   * Byte-pinned under the iPhone idiom and named-noun-checked under the
   * rest, so a hardcoded "this phone" (or "this iPhone") in the deck fails
   * here on the idioms it lies to. */

  it('iPhone: the linking ceremony copy names the device truthfully', () => {
    const d = decksUnder({ os: 'ios', isPad: false });
    expect(d.LINKING_COPY.codeInstruction).toBe(
      'Compare this code with the one on the new device. If every group matches, confirm here on this iPhone first, then on the new device.',
    );
    expect(d.LINKING_COPY.notPristine).toContain('This iPhone already has a life of its own');
    expect(d.LINKING_COPY.verificationLocal).toContain(
      "This list is this iPhone's own record of your devices.",
    );
    // The consent-grade strings: the slot assertion the acceptance signature
    // makes, and the same-class refusal — both name THIS device truthfully.
    expect(d.LINKING_COPY.slotAssertion('phone')).toBe(
      "This iPhone will join as the account's phone.",
    );
    expect(d.LINKING_COPY.classMismatch).toContain(
      'This iPhone is the same kind of device as the one that sent the request.',
    );
  });

  it('iPad: the linking copy follows the idiom', () => {
    const d = decksUnder({ os: 'ios', isPad: true });
    expect(d.LINKING_COPY.codeInstruction).toContain('confirm here on this iPad first');
    expect(d.LINKING_COPY.notPristine).toContain('This iPad already has a life of its own');
    expect(d.LINKING_COPY.slotAssertion('tablet')).toBe(
      "This iPad will join as the account's tablet.",
    );
    expect(d.LINKING_COPY.classMismatch).toContain('This iPad is the same kind of device');
  });

  it('Android phone and tablet: the linking copy follows the sw600dp cut', () => {
    const phone = decksUnder({ os: 'android', screen: { width: 393, height: 852 } });
    expect(phone.LINKING_COPY.codeInstruction).toContain('confirm here on this phone first');
    expect(phone.LINKING_COPY.verificationLocal).toContain("this phone's own record");
    expect(phone.LINKING_COPY.classMismatch).toContain('This phone is the same kind of device');
    const tablet = decksUnder({ os: 'android', screen: { width: 800, height: 1280 } });
    expect(tablet.LINKING_COPY.codeInstruction).toContain('confirm here on this tablet first');
    expect(tablet.LINKING_COPY.notPristine).toContain('This tablet already has a life of its own');
    expect(tablet.LINKING_COPY.slotAssertion('tablet')).toBe(
      "This tablet will join as the account's tablet.",
    );
  });

  /* The identifier/discovery/recovery deck (new
   * consent-grade copy EXTENDS this suite rather than regressing it) —
   * every device-naming sentence follows the idiom, and the two
   * idiom-INVARIANT commitments (the narrow recovery scope, the designed
   * discovery indistinguishability) are pinned as invariant. */

  it('iPhone: the accounts copy names the device truthfully', () => {
    const d = decksUnder({ os: 'ios', isPad: false });
    expect(d.ACCOUNTS_COPY.emailIntro).toContain(
      'this iPhone still signs in with its key',
    );
    expect(d.ACCOUNTS_COPY.downgradeIntro).toContain('nothing leaves this iPhone');
    expect(d.ACCOUNTS_COPY.recoverNeedsIdentity).toContain(
      'this iPhone creates its own fresh identity',
    );
  });

  it('iPad and Android idioms: the accounts copy follows the noun', () => {
    const pad = decksUnder({ os: 'ios', isPad: true });
    expect(pad.ACCOUNTS_COPY.emailIntro).toContain('this iPad still signs in with its key');
    expect(pad.ACCOUNTS_COPY.downgradeIntro).toContain('nothing leaves this iPad');
    const phone = decksUnder({ os: 'android', screen: { width: 393, height: 852 } });
    expect(phone.ACCOUNTS_COPY.recoverNeedsIdentity).toContain(
      'this phone creates its own fresh identity',
    );
    const tablet = decksUnder({ os: 'android', screen: { width: 800, height: 1280 } });
    expect(tablet.ACCOUNTS_COPY.emailIntro).toContain(
      'this tablet still signs in with its key',
    );
    expect(tablet.ACCOUNTS_COPY.downgradeIntro).toContain('nothing leaves this tablet');
  });

  it('the recovery scope and the discovery indistinguishability are idiom-INVARIANT', () => {
    for (const idiom of [
      { os: 'ios' as const, isPad: false },
      { os: 'ios' as const, isPad: true },
      { os: 'android' as const, screen: { width: 393, height: 852 } },
      { os: 'android' as const, screen: { width: 800, height: 1280 } },
    ]) {
      const d = decksUnder(idiom);
      // The scope, verbatim across idioms: grouping + findability only; never
      // messages, never keys; peers see a full safety reset.
      expect(d.ACCOUNTS_COPY.recoverScope).toContain(
        'Recovery restores two things only',
      );
      expect(d.ACCOUNTS_COPY.recoverScope).toContain('Your messages are not here');
      expect(d.ACCOUNTS_COPY.recoverScope).toContain('a new safety number');
      // The designed collapse, said in the copy on every idiom.
      expect(d.ACCOUNTS_COPY.discoverNoMatch).toContain(
        'Tacendum cannot tell you which, by design.',
      );
      // The recipient-budget honesty (the email-code amendment):
      // the maybe IN the uniform-answer notice, and the numbers behind the
      // ⓘ — deliberately noun-free sentences, invariant across idioms.
      expect(d.ACCOUNTS_COPY.emailCodeSent('a@b.example')).toContain(
        'codes are rationed, so asking again does not always send again',
      );
      expect(d.ACCOUNTS_COPY.emailCodeBudget.join(' ')).toContain(
        'at most 5 codes in a day, and never more than one a minute',
      );
      // The day is a UTC day, and the copy says so: a local
      // "tomorrow" can still be the same rationing day.
      expect(d.ACCOUNTS_COPY.emailCodeBudget.join(' ')).toContain(
        'resets at midnight UTC, which is probably not your midnight',
      );
    }
  });

  it('the two Settings entry labels are idiom-INVARIANT — they name surfaces, never this device', () => {
    // The rows are landed. Their
    // labels live in the decks — the chokepoints — and deliberately carry
    // no idiom noun: "Linked devices" names the ACCOUNT's devices and
    // "Email & discovery" names a surface, so both must render the same
    // bytes on every idiom. Settings.account.test.tsx pins that the screen
    // reads exactly these slots.
    for (const idiom of [
      { os: 'ios' as const, isPad: false },
      { os: 'ios' as const, isPad: true },
      { os: 'android' as const, screen: { width: 393, height: 852 } },
      { os: 'android' as const, screen: { width: 800, height: 1280 } },
    ]) {
      const d = decksUnder(idiom);
      expect(d.LINKING_COPY.settingsRow).toBe('Linked devices');
      expect(d.ACCOUNTS_COPY.settingsRow).toBe('Email & discovery');
    }
  });

  /* The PHONE deck (new consent-grade copy
   * EXTENDS this suite rather than regressing it) — the one device-naming
   * template follows the idiom, and the phone class's two RULED
   * commitments (the honest weakness at full sharpness, the
   * per-class consent fact) are pinned idiom-INVARIANT. */

  it('the phone deck names the device truthfully on every idiom', () => {
    const iphone = decksUnder({ os: 'ios', isPad: false });
    expect(iphone.ACCOUNTS_PHONE_COPY.numberIntro).toContain(
      'this iPhone still signs in with its key',
    );
    const pad = decksUnder({ os: 'ios', isPad: true });
    expect(pad.ACCOUNTS_PHONE_COPY.numberIntro).toContain(
      'this iPad still signs in with its key',
    );
    const phone = decksUnder({ os: 'android', screen: { width: 393, height: 852 } });
    expect(phone.ACCOUNTS_PHONE_COPY.numberIntro).toContain(
      'this phone still signs in with its key',
    );
    const tablet = decksUnder({ os: 'android', screen: { width: 800, height: 1280 } });
    expect(tablet.ACCOUNTS_PHONE_COPY.numberIntro).toContain(
      'this tablet still signs in with its key',
    );
  });

  it('the honest weakness and the per-class fact are idiom-INVARIANT', () => {
    for (const idiom of [
      { os: 'ios' as const, isPad: false },
      { os: 'ios' as const, isPad: true },
      { os: 'android' as const, screen: { width: 393, height: 852 } },
      { os: 'android' as const, screen: { width: 800, height: 1280 } },
    ]) {
      const d = decksUnder(idiom).ACCOUNTS_PHONE_COPY;
      // The honest weakness at FULL sharpness (the previous
      // pins admitted a softened sentence): the ~10^10 keyspace named, the
      // MECHANISM in the sentence (the secret PLUS the caller gates and
      // budgets — never the scrambling alone), and the RULED phrase
      // "never server-blindness" verbatim, not the softer "not blindness".
      const honest = d.discoverableExplain.join(' ');
      expect(honest).toContain('about ten billion possible phone numbers');
      expect(honest).toContain(
        'only through that secret plus the strict limits on who may search and how often',
      );
      expect(honest).toContain('never server-blindness');
      // The unlink confirm's keep verb lives in the deck: a
      // hardcoded screen literal escapes this suite's drift net.
      expect(d.numberUnlinkKeep).toBe('Keep it');
      // The per-class fact, in plain words, on the toggle itself.
      expect(honest).toContain(
        'does not make your email findable, and the other way round',
      );
      // The extended recovery scope keeps every commitment of the landed
      // sentence — two things only, no messages, the safety reset.
      expect(d.recoverScopeBoth).toContain('Recovery restores two things only');
      expect(d.recoverScopeBoth).toContain('Your messages are not here');
      expect(d.recoverScopeBoth).toContain('a new safety number');
      // The designed collapse closes the phone miss sentence too.
      expect(d.discoverNoMatchNumber).toContain(
        'Tacendum cannot tell you which, by design.',
      );
      // The recipient-budget honesty, per class (the email-code
      // amendment's phone twin): the same maybe, the phone class's own
      // numbers — noun-free sentences, invariant across idioms.
      expect(d.numberCodeSent('+15555550100')).toContain(
        'codes are rationed, so asking again does not always send again',
      );
      expect(d.numberCodeBudget.join(' ')).toContain(
        'at most 3 codes in a day, and never more than one a minute',
      );
      // The UTC-day boundary, pinned on the phone twin too.
      expect(d.numberCodeBudget.join(' ')).toContain(
        'resets at midnight UTC, which is probably not your midnight',
      );
      // The staged Settings-row label names a surface, never this device
      // (the row itself stays DEFERRED — the honest ledger).
      expect(d.settingsRow).toBe('Phone number & discovery');
      // The SMS consent sentence (the US toll-free DIGITAL_FORM opt-in):
      // ONE deck string, noun-free by construction, byte-pinned on every
      // idiom — the carrier registration's description quotes it verbatim,
      // so any drift here is a drift in what was registered.
      expect(d.smsConsentLabel).toBe(
        'By checking, you consent to receive one-time verification codes from Mirana Technologies Inc. Message frequency: one code per request. Message and data rates may apply. Reply HELP for help or STOP to opt out.',
      );
    }
  });

  it('the history sentence is idiom-INVARIANT — it names the joining device, never this one', () => {
    for (const idiom of [
      { os: 'ios' as const, isPad: false },
      { os: 'ios' as const, isPad: true },
      { os: 'android' as const, screen: { width: 393, height: 852 } },
      { os: 'android' as const, screen: { width: 800, height: 1280 } },
    ]) {
      expect(decksUnder(idiom).LINKING_COPY.historyStance).toBe(
        'This device shows messages from today forward.',
      );
    }
  });

  it('Android tablet: the Galaxy-Tab sentence stops being wrong', () => {
    const d = decksUnder({ os: 'android', screen: { width: 800, height: 1280 } });
    expect(d.BLOCK_COPY.statusLabel).toBe('Blocked on this tablet');
    expect(d.SAFETY_COPY.mismatched.label).toBe('Did not match on this tablet');
    expect(d.VAULT_LIMITS[1]).toContain(
      'If this tablet is lost the vault goes with it; there is no recovery key.',
    );
    expect(d.REPORT_COPY.failed).toBe(
      'The report was not sent. Nothing left your tablet — try again.',
    );
    // The Android substance arm still omits the screenshot-notice clause
    // (prevented, not disclosed) — on tablets exactly as on phones.
    expect(d.BLOCK_EXPLAINER[2]).toBe(
      'While they are blocked, this tablet sends them nothing: no replies, no delivery or read marks, no reactions, no calls. To them the chat looks like one where you stopped replying.',
    );
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * The allowlist: where "iPhone" may still occur in the production tree.
 * ──────────────────────────────────────────────────────────────────────── */

/** file (repo-app-relative, forward slashes) + a substring every hit line in
 * that file must contain ('' = any line in the file is fine). */
const ALLOWLIST: ReadonlyArray<{ file: string; mustContain: string }> = [
  // The token's own definition — the one module allowed to spell the nouns.
  { file: 'src/deviceNoun.ts', mustContain: '' },
  // A deliberate comment: it records that iPhone renderings stayed verbatim.
  {
    file: 'src/screens/RegisterScreen.tsx',
    mustContain: 'On an iPhone every rendering',
  },
  // The diagram-deck KEY named `thisIphone` — an identifier naming the slot,
  // not wording; renaming it would churn the register diagrams for nothing
  // (its VALUE is the token: `THIS ${DEVICE_NOUN.toUpperCase()}`).
  { file: 'src/ui/IdentityDiagrams.tsx', mustContain: 'thisIphone' },
];

function productionFiles(): string[] {
  const out: string[] = [join(APP_ROOT, 'App.tsx')];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(name)) out.push(full);
    }
  };
  walk(join(APP_ROOT, 'src'));
  return out;
}

describe('the remaining "iPhone" occurrences match the explicit allowlist', () => {
  const hits: Array<{ file: string; line: number; text: string }> = [];
  for (const full of productionFiles()) {
    const rel = relative(APP_ROOT, full).split('\\').join('/');
    readFileSync(full, 'utf8')
      .split('\n')
      .forEach((text, i) => {
        if (/iphone/i.test(text)) hits.push({ file: rel, line: i + 1, text });
      });
  }

  it('every occurrence is allowlisted — a new one must go through the token', () => {
    const offenders = hits.filter(
      hit =>
        !ALLOWLIST.some(
          row =>
            row.file === hit.file &&
            (row.mustContain === '' || hit.text.includes(row.mustContain)),
        ),
    );
    expect(
      offenders.map(h => `${h.file}:${h.line}: ${h.text.trim()}`),
    ).toEqual([]);
  });

  it('every allowlist row still matches something — stale rows come off the list', () => {
    const stale = ALLOWLIST.filter(
      row =>
        !hits.some(
          hit =>
            hit.file === row.file &&
            (row.mustContain === '' || hit.text.includes(row.mustContain)),
        ),
    );
    expect(stale).toEqual([]);
  });

  it('the scan really scans (the token module is found)', () => {
    expect(hits.some(h => h.file === 'src/deviceNoun.ts')).toBe(true);
  });
});
