/**
 * The one-action identity screen, redesigned (identity-redesign mockup,
 * approved deliberately).
 *
 * Two things are being protected here, and only one of them is mechanical.
 *
 * The mechanical half: the consent checkbox arms the button, the button
 * presents an in-tree confirm sheet, and the sheet's own button performs the
 * one create call — whose profile is handed straight on.
 *
 * The other half is the copy, and it is the reason this file asserts on exact
 * sentences (which tests normally should not do). The mockup is the spec and
 * every user-facing string ships verbatim from it: the lead, the three facts
 * and their ⓘ teaching lines, the agreement sentence, both sheet rows, and
 * the two shipped error strings. A rewrite that rewords any of them is a
 * change of spec, and this suite is where that shows.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import {
  AccessibilityInfo,
  BackHandler,
  Dimensions,
  Linking,
  ScrollView,
  StyleSheet,
} from 'react-native';

/** The raw module object, not Babel's `import *` interop copy: redefining
 * `findNodeHandle` must land on the object the screen itself reads from. */
const RN: typeof import('react-native') = require('react-native');
import { ApiRequestError } from '../src/api';
import { RegisterScreen } from '../src/screens/RegisterScreen';
import { PRIVACY_URL, TERMS_URL } from '../src/version';

jest.mock('../src/registration', () => ({
  createOrRestoreAccount: jest.fn(),
}));

const reg = jest.requireMock('../src/registration') as {
  createOrRestoreAccount: jest.Mock;
};

const PROFILE = {
  userId: '01KYDBSSDJSPC9J0E5N2AWMJ5Y',
  registrationId: 7,
  displayName: '',
  about: '',
  avatarB64: '',
  profileVersion: 0,
};

let tree: ReactTestRenderer.ReactTestRenderer;
let onRegistered: jest.Mock;

async function render() {
  onRegistered = jest.fn();
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <RegisterScreen onBack={jest.fn()} onRegistered={onRegistered} />,
    );
  });
}

/** A testID legitimately lands on both a composite (PrimaryButton,
 * Pressable, Animated.View) and the host view it renders — so a lookup names
 * the prop it is after and takes the outermost node that carries it. */
const maybe = (id: string) => tree.root.findAllByProps({ testID: id });
const has = (id: string) => maybe(id).length > 0;
const propOf = (id: string, prop: string) => {
  const node = maybe(id).find(n => n.props[prop] !== undefined);
  if (!node) throw new Error(`no node with testID ${id} carries ${prop}`);
  return node.props[prop];
};
const stateOf = (id: string) =>
  propOf(id, 'accessibilityState') as {
    disabled?: boolean;
    checked?: boolean;
    busy?: boolean;
  };

async function press(id: string) {
  await ReactTestRenderer.act(async () => {
    propOf(id, 'onPress')();
  });
}

/** Tick the consent checkbox so the Create button is live. */
async function arm() {
  await press('register-consent');
}

/** Arm and open the confirm sheet. */
async function openSheet() {
  await arm();
  await press('create-identity');
}

/** Every string currently on screen, whatever nests it. */
function visibleText(): string {
  return JSON.stringify(tree.toJSON());
}

/** Real elapsed time inside act — never fake timers beside live deadline
 * arithmetic (a frozen clock has hidden release-blocking defects here). */
const settle = (ms: number) =>
  ReactTestRenderer.act(async () => {
    await new Promise<void>(resolve => setTimeout(() => resolve(), ms));
  });

afterEach(() => {
  tree?.unmount();
  jest.clearAllMocks();
  jest.restoreAllMocks();
});

describe('what the screen says before anyone commits', () => {
  it('leads with the key and states the three facts verbatim', async () => {
    await render();
    const text = visibleText();
    expect(text).toContain(
      'No account to set up. Your identity is a key — and this iPhone is about to make it for you.',
    );
    expect(text).toContain('A key, made on this iPhone');
    expect(text).toContain('Nothing to type, nothing to remember');
    expect(text).toContain('The private half never leaves');
  });

  it('each fact ⓘ ships closed and expands to its exact teaching copy', async () => {
    await render();

    const lines = [
      {
        id: 'register-info-key',
        line: 'The key is the whole account. To sign you in it signs a one-time number from our server — no password exists to steal, guess, or reset.',
      },
      {
        id: 'register-info-reach',
        // The reach line carries the consent-gated findability clause since
        // design: with find-by-email in the product,
        // an unconditional "only way" would be false the day the email flag
        // flips. This suite runs under the REAL build pins: the username pin
        // is ON since build 23, the phone pin still OFF —
        // so the sentence names the email class and the username clause, and
        // never the phone.
        line: 'There is no directory and no contact upload. You hand someone your ID as a QR code or 26 written characters — and unless you later link an email, or choose a username, in Settings and switch on findability, that is the only way anyone can reach you.',
      },
      {
        id: 'register-info-server',
        line: 'The public half of your key, plus one-time keys that let people reach you while this iPhone is offline. No phone number, no email, no name, nothing from your contacts.',
      },
    ] as const;

    for (const { line } of lines) {
      expect(visibleText()).not.toContain(line);
    }
    for (const { id, line } of lines) {
      await press(id);
      expect(visibleText()).toContain(line);
    }
  });

  it('the consent card says the agreement sentence in the open, under its label', async () => {
    await render();
    const text = visibleText();
    expect(text).toContain('BEFORE YOU CREATE IT');
    expect(text).toContain(
      'I understand: if I lose this iPhone, my identity can’t be recovered — not even by Tacendum.',
    );
  });

  it('the why-no-recovery ⓘ expands to its three lines verbatim', async () => {
    await render();
    const lines = [
      'Any door that could restore an identity would also open for whoever asked convincingly enough.',
      'If this iPhone is lost or wiped, you would create a fresh identity and the people you talk to would add you again.',
      'What comes next: encrypted backups that only you hold the key to.',
    ];
    for (const line of lines) expect(visibleText()).not.toContain(line);
    await press('register-info-recovery');
    for (const line of lines) expect(visibleText()).toContain(line);
  });

  it('offers no phone, code, or PIN field to fill in', async () => {
    await render();
    for (const dead of ['phone-input', 'code-input', 'pin-input']) {
      expect(maybe(dead)).toHaveLength(0);
    }
  });
});

describe('the checkbox arms the button', () => {
  it('starts unticked with the button recessed and disabled to VoiceOver', async () => {
    await render();
    expect(stateOf('register-consent').checked).toBe(
      false,
    );
    expect(stateOf('create-identity').disabled).toBe(
      true,
    );
  });

  it('an unticked press on Create presents nothing and creates nothing', async () => {
    await render();
    await press('create-identity');
    expect(has('register-sheet')).toBe(false);
    expect(reg.createOrRestoreAccount).not.toHaveBeenCalled();
  });

  it('ticking arms the button; unticking recesses it again', async () => {
    await render();
    await arm();
    expect(stateOf('register-consent').checked).toBe(
      true,
    );
    expect(stateOf('create-identity').disabled).toBe(
      false,
    );
    await press('register-consent');
    expect(stateOf('create-identity').disabled).toBe(
      true,
    );
  });
});

describe('the confirm sheet', () => {
  it('presents on Create with both rows verbatim, and creates nothing yet', async () => {
    await render();
    await openSheet();

    expect(has('register-sheet')).toBe(true);
    const text = visibleText();
    expect(text).toContain('BEFORE YOUR KEY IS MADE');
    expect(text).toContain('Two things worth knowing');
    expect(text).toContain(
      'This iPhone is the only place your identity lives.',
    );
    expect(text).toContain(
      'If it is lost or wiped, nobody can restore the identity — not even us. You would start fresh, and the people you know would add you again.',
    );
    expect(text).toContain('Only the public half of your key leaves.');
    expect(text).toContain(
      'It goes to our server, along with the one-time keys that let people reach you — no phone number, no email, no name attached. The private half stays here.',
    );
    expect(text).toContain('Not yet');
    expect(reg.createOrRestoreAccount).not.toHaveBeenCalled();
  });

  it('confirming in-sheet performs the one create call and hands the profile on', async () => {
    reg.createOrRestoreAccount.mockResolvedValueOnce(PROFILE);
    await render();
    await openSheet();
    await press('register-sheet-confirm');

    expect(reg.createOrRestoreAccount).toHaveBeenCalledTimes(1);
    expect(onRegistered).toHaveBeenCalledWith(PROFILE);
  });

  it('goes busy in-sheet while the create call is in flight', async () => {
    reg.createOrRestoreAccount.mockReturnValueOnce(new Promise(() => {}));
    await render();
    await openSheet();
    await press('register-sheet-confirm');

    expect(stateOf('register-sheet-confirm').busy).toBe(
      true,
    );
    // Mid-flight there is nothing safe to walk away to: the scrim stops
    // dismissing until the call answers.
    propOf('register-sheet-scrim', 'onPress')();
    expect(has('register-sheet')).toBe(true);
  });

  it('Not yet dismisses with the checkbox still ticked and nothing lost', async () => {
    await render();
    await openSheet();
    await press('register-sheet-dismiss');

    expect(has('register-sheet')).toBe(false);
    expect(stateOf('register-consent').checked).toBe(
      true,
    );
    expect(stateOf('create-identity').disabled).toBe(
      false,
    );
    expect(reg.createOrRestoreAccount).not.toHaveBeenCalled();
  });

  it('a scrim tap dismisses the same way', async () => {
    await render();
    await openSheet();
    await press('register-sheet-scrim');

    expect(has('register-sheet')).toBe(false);
    expect(stateOf('register-consent').checked).toBe(
      true,
    );
  });

  it('moves VoiceOver focus to the sheet title, and back to Create on dismiss', async () => {
    const focus = jest
      .spyOn(AccessibilityInfo, 'setAccessibilityFocus')
      .mockImplementation(() => {});
    // The test renderer has no native views, so the real findNodeHandle always
    // answers null and the focus call would never be reached. Standing in a
    // tag is what lets this assert the transfer rather than the null check.
    const handle = jest.fn(() => 42);
    const original = Object.getOwnPropertyDescriptor(RN, 'findNodeHandle')!;
    Object.defineProperty(RN, 'findNodeHandle', {
      configurable: true,
      get: () => handle,
    });

    try {
      await render();
      await openSheet();
      expect(focus).toHaveBeenCalledWith(42);

      const presented = focus.mock.calls.length;
      await press('register-sheet-dismiss');
      expect(focus.mock.calls.length).toBeGreaterThan(presented);
    } finally {
      Object.defineProperty(RN, 'findNodeHandle', original);
    }
  });
});

describe('failure, in the sheet where the attempt was made', () => {
  it('a failure shows the shipped string in-sheet and never claims an identity exists', async () => {
    reg.createOrRestoreAccount.mockRejectedValueOnce(new Error('keygen died'));
    await render();
    await openSheet();
    await press('register-sheet-confirm');

    expect(has('register-sheet')).toBe(true);
    const message = propOf('register-error', 'message') as string;
    expect(message).toBe(
      'Tacendum couldn’t finish setting up your identity. Check your connection and try again.',
    );
    expect(message).not.toContain('keygen');
    expect(onRegistered).not.toHaveBeenCalled();
  });

  it('names the one failure waiting actually fixes', async () => {
    reg.createOrRestoreAccount.mockRejectedValueOnce(
      new ApiRequestError('rate limited', 429, 'rate_limited'),
    );
    await render();
    await openSheet();
    await press('register-sheet-confirm');

    expect(propOf('register-error', 'message')).toBe(
      'Too many tries. Wait a minute, then try again.',
    );
  });

  it('still tells the truth about a lost identity key', async () => {
    // The identityLost notice ships unchanged — out of the redesign's scope.
    // Pinned as the complete shipped bytes: the "never leaves the
    // iPhone / can't be restored" clause is the consent-grade heart of the
    // notice, and a regex on the first phrase alone would let it drift.
    const gone = new Error('key gone');
    gone.name = 'IdentityLostError';
    reg.createOrRestoreAccount.mockRejectedValueOnce(gone);
    await render();
    await openSheet();
    await press('register-sheet-confirm');

    expect(propOf('register-error', 'message')).toBe(
      'This iPhone no longer has the identity key these conversations belong to. ' +
        'The key never leaves the iPhone it was made on and can’t be restored — ' +
        'not from a backup, and not by us. Your messages here are safe to read, ' +
        'but this identity can’t send or receive. To keep talking, you’d start a ' +
        'fresh identity and the people you know would add you again.',
    );
  });

  it('a retry after a failure clears the old message', async () => {
    reg.createOrRestoreAccount.mockRejectedValueOnce(new Error('offline'));
    await render();
    await openSheet();
    await press('register-sheet-confirm');
    expect(has('register-error')).toBe(true);

    reg.createOrRestoreAccount.mockResolvedValueOnce(PROFILE);
    await press('register-sheet-confirm');
    expect(has('register-error')).toBe(false);
    expect(onRegistered).toHaveBeenCalledWith(PROFILE);
  });
});

describe('how this works', () => {
  it('ships collapsed: explanation stays behind the affordance', async () => {
    await render();
    expect(visibleText()).not.toContain('signing a one-time number');
  });

  it('expands in place to the three ruled rows, diagrams and paragraphs', async () => {
    await render();
    await press('register-explain');

    const text = visibleText();
    expect(text).toContain('THE KEY');
    expect(text).toContain('REACHING YOU');
    expect(text).toContain('IF THIS IPHONE IS LOST');
    expect(text).toContain(
      'The key is made here and the private half never leaves this iPhone. Proving who you are means signing a one-time number from the server — which is why there is no password to steal, guess, or reset.',
    );
    expect(text).toContain(
      'Your identity needs no phone number and no email, so there is no directory to look you up in and no contact list to upload. You hand your ID to someone as a QR code or as 26 written characters — unless you later link an email, or choose a username, and choose to be findable by it, that is the only way anyone reaches you.',
    );
    expect(text).toContain(
      'A lost iPhone is final: any door that could restore an identity would also open for whoever asked convincingly enough. Instead of a recovery desk, what comes next is encrypted backups that only you hold the key to.',
    );
    // The diagrams' Menlo captions — display copy only, never a payload.
    expect(text).toContain('OUR SERVER');
    expect(text).toContain('K3TQ7…');
    expect(text).toContain('GONE WITH IT');
    expect(text).toContain('A FRESH IDENTITY');
  });

  it('collapse reverses', async () => {
    await render();
    await press('register-explain');
    expect(visibleText()).toContain('signing a one-time number');

    await press('register-explain');
    // The rows fade out on motion.surface before unmounting; wait it out in
    // real time.
    await settle(400);
    expect(visibleText()).not.toContain('signing a one-time number');
  });
});

describe('policies at the page foot', () => {
  it('opens the privacy policy and terms externally', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    await render();
    await press('register-privacy');
    expect(open).toHaveBeenCalledWith(PRIVACY_URL);
    await press('register-terms');
    expect(open).toHaveBeenCalledWith(TERMS_URL);
  });
});

describe('the sheet as a real modal surface', () => {
  it('puts the modal flag on the host, so the page behind leaves the VoiceOver order', async () => {
    await render();
    await openSheet();
    // The flag must sit on the container whose SIBLINGS are the page —
    // UIKit ignores only siblings of the flagged view, so on the sheet
    // itself it was a no-op and the scrimmed page stayed reachable.
    expect(propOf('register-sheet-host', 'accessibilityViewIsModal')).toBe(
      true,
    );
    const host = maybe('register-sheet-host')[0];
    expect(
      host.findAllByProps({ testID: 'register-sheet-scrim' }).length,
    ).toBeGreaterThan(0);
    expect(
      host.findAllByProps({ testID: 'register-sheet' }).length,
    ).toBeGreaterThan(0);
    const sheetModal = maybe('register-sheet').some(
      n => n.props.accessibilityViewIsModal,
    );
    expect(sheetModal).toBe(false);
  });

  it('the VoiceOver escape gesture dismisses like Not yet', async () => {
    await render();
    await openSheet();
    await ReactTestRenderer.act(async () => {
      propOf('register-sheet', 'onAccessibilityEscape')();
    });
    expect(has('register-sheet')).toBe(false);
    expect(stateOf('register-consent').checked).toBe(true);
    expect(reg.createOrRestoreAccount).not.toHaveBeenCalled();
  });

  it('the escape gesture is refused while the create call is in flight', async () => {
    reg.createOrRestoreAccount.mockReturnValueOnce(new Promise(() => {}));
    await render();
    await openSheet();
    await press('register-sheet-confirm');
    await ReactTestRenderer.act(async () => {
      propOf('register-sheet', 'onAccessibilityEscape')();
    });
    expect(has('register-sheet')).toBe(true);
  });

  it('confirm refuses to fire once consent has been untoggled beneath the sheet', async () => {
    await render();
    await openSheet();
    // The VoiceOver-leak path: the page behind the scrim was reachable and
    // the checkbox could be unticked with the sheet still up. The consent
    // that legally arms the flow must hold at the moment the key is made.
    await press('register-consent');
    await press('register-sheet-confirm');
    expect(reg.createOrRestoreAccount).not.toHaveBeenCalled();
  });

  it('a doubled activation in one event batch mints exactly one identity', async () => {
    reg.createOrRestoreAccount.mockResolvedValue(PROFILE);
    await render();
    await openSheet();
    await ReactTestRenderer.act(async () => {
      const fire = propOf('register-sheet-confirm', 'onPress');
      fire();
      fire();
    });
    expect(reg.createOrRestoreAccount).toHaveBeenCalledTimes(1);
    expect(onRegistered).toHaveBeenCalledTimes(1);
  });

  it('backs the app-root safe area out so scrim and sheet reach the display edges', async () => {
    const sac = require('react-native-safe-area-context') as {
      useSafeAreaInsets: jest.Mock;
    };
    const original = sac.useSafeAreaInsets.getMockImplementation();
    sac.useSafeAreaInsets.mockImplementation(() => ({
      top: 59,
      bottom: 34,
      left: 0,
      right: 0,
    }));
    try {
      await render();
      await openSheet();
      // The register route mounts inside App's SafeAreaView (top+bottom), so
      // an absoluteFill host stops 34pt short of the home indicator and the
      // sheet's own `14 + inset` pad double-counted the clearance.
      const hostStyle = StyleSheet.flatten(
        maybe('register-sheet-host')[0].props.style,
      ) as { top?: number; bottom?: number };
      expect(hostStyle.top).toBe(-59);
      expect(hostStyle.bottom).toBe(-34);
      const sheetStyle = StyleSheet.flatten(
        propOf('register-sheet', 'style'),
      ) as { paddingBottom?: number };
      expect(sheetStyle.paddingBottom).toBe(14 + 34);
    } finally {
      if (original) sac.useSafeAreaInsets.mockImplementation(original);
    }
  });

  it('caps its height under the status area and scrolls the rows, buttons pinned', async () => {
    await render();
    await openSheet();
    const sheetStyle = StyleSheet.flatten(
      propOf('register-sheet', 'style'),
    ) as { maxHeight?: number };
    // Without a ceiling, large Dynamic Type grows the bottom-anchored sheet
    // past the window top: the consequence rows clip off-screen while the
    // Create button stays visible — confirmable without being readable.
    expect(typeof sheetStyle.maxHeight).toBe('number');
    const scroll = maybe('register-sheet')[0].findAllByType(ScrollView)[0];
    expect(scroll).toBeDefined();
    expect(
      scroll.findAll(n => n.props?.children === 'Two things worth knowing')
        .length,
    ).toBeGreaterThan(0);
    // The confirm button stays outside the scroll region, always reachable.
    expect(
      scroll.findAllByProps({ testID: 'register-sheet-confirm' }),
    ).toHaveLength(0);
  });

  it('starts the slide from the measured height, frozen at first layout', async () => {
    await render();
    await openSheet();
    const startOffset = () => {
      const style = StyleSheet.flatten(propOf('register-sheet', 'style')) as {
        transform?: Array<Record<string, unknown>>;
      };
      const entry = style.transform!.find(e => 'translateY' in e)!;
      return (
        entry.translateY as { _config?: { outputRange?: number[] } }
      )._config?.outputRange?.[0];
    };
    // Unmeasured, the sheet parks a full window off-screen — never the old
    // 560 guess a tall accessibility-text sheet could overshoot.
    expect(startOffset()).toBe(Dimensions.get('window').height);
    await ReactTestRenderer.act(async () => {
      propOf('register-sheet', 'onLayout')({
        nativeEvent: { layout: { height: 620 } },
      });
    });
    expect(startOffset()).toBe(620);
    // A later, different layout must not snap the slide's start mid-flight.
    await ReactTestRenderer.act(async () => {
      propOf('register-sheet', 'onLayout')({
        nativeEvent: { layout: { height: 700 } },
      });
    });
    expect(startOffset()).toBe(620);
  });
});

describe('touch targets and the busy button', () => {
  it('the consent row keeps the 44pt touch target', async () => {
    await render();
    const resolved = maybe('register-consent')
      .map(n => n.props.style)
      .filter(s => s != null && typeof s !== 'function')
      .map(s => StyleSheet.flatten(s) as { minHeight?: number });
    expect(resolved.some(s => (s.minHeight ?? 0) >= 44)).toBe(true);
  });

  it('keeps saying "Creating your identity…" beside the spinner while busy', async () => {
    reg.createOrRestoreAccount.mockReturnValueOnce(new Promise(() => {}));
    await render();
    await openSheet();
    await press('register-sheet-confirm');
    // The designer note: Busy label "Creating your identity…" WITH spinner —
    // under default motion, not only under Reduce Motion.
    expect(visibleText()).toContain('Creating your identity…');
    // And VoiceOver announces the state change, not the idle name.
    expect(propOf('register-sheet-confirm', 'accessibilityLabel')).toBe(
      'Creating your identity…',
    );
  });
});

describe('motion honours Reduce Motion', () => {
  it('breathes the halo only when motion is welcome', async () => {
    await render();
    const halo = StyleSheet.flatten(propOf('register-hero-halo', 'style'));
    // Live: the opacity is an animated node, not a resting number.
    expect(typeof halo.opacity).not.toBe('number');
  });

  it('stills the halo and swaps the sheet slide for a fade under Reduce Motion', async () => {
    // Replaced and put back by hand: the preset already ships this as a mock
    // function, so spyOn has no original to restore and a sticky resolved
    // value would leak Reduce Motion into every later test. Not
    // mockResolvedValueOnce either — the header's BrandLockup asks first and
    // would eat the single answer before the screen's own hook asks.
    const original = AccessibilityInfo.isReduceMotionEnabled;
    AccessibilityInfo.isReduceMotionEnabled = jest.fn(async () => true);
    try {
      await render();

      const halo = StyleSheet.flatten(propOf('register-hero-halo', 'style'));
      expect(halo.opacity).toBe(1);

      await openSheet();
      const sheet = StyleSheet.flatten(propOf('register-sheet', 'style'));
      expect(sheet.transform).toBeUndefined();
    } finally {
      AccessibilityInfo.isReduceMotionEnabled = original;
    }
  });

  it('slides the sheet up when motion is welcome', async () => {
    await render();
    await openSheet();
    const sheet = StyleSheet.flatten(propOf('register-sheet', 'style'));
    expect(sheet.transform).toBeDefined();
  });
});

describe('hardware back while the create call is in flight', () => {
  /** Capture the screen's own hardwareBackPress subscription: RN invokes
   * the most recent subscriber first and stops at the first `true`, so a
   * screen subscription answers before the app router's. */
  function captureBack() {
    const handlers: Array<() => boolean> = [];
    const remove = jest.fn();
    const spy = jest
      .spyOn(BackHandler, 'addEventListener')
      .mockImplementation((_event, handler) => {
        handlers.push(handler as () => boolean);
        return { remove };
      });
    return { handlers, remove, spy };
  }

  it('is swallowed while busy, yielded to the router otherwise, and leaves with the screen', async () => {
    const { handlers, remove } = captureBack();
    reg.createOrRestoreAccount.mockReturnValueOnce(new Promise(() => {}));
    await render();
    expect(handlers.length).toBeGreaterThan(0);
    const back = handlers[handlers.length - 1];

    // Idle: the app's own router answers (register pops to landing).
    expect(back()).toBe(false);
    await openSheet();
    expect(back()).toBe(false);

    // Mid-flight there is nothing safe to walk away to — the sheet already
    // refuses its scrim and "Not yet"; the system button refuses the same.
    await press('register-sheet-confirm');
    expect(stateOf('register-sheet-confirm').busy).toBe(true);
    expect(back()).toBe(true);
    expect(has('register-sheet')).toBe(true);

    // Inside act: the passive-effect cleanup that removes the subscription
    // is what is being asserted.
    await ReactTestRenderer.act(async () => {
      tree.unmount();
    });
    expect(remove).toHaveBeenCalled();
  });

  it('a failure landing after the screen is gone is dropped, and hands nobody on', async () => {
    captureBack();
    let reject!: (err: Error) => void;
    reg.createOrRestoreAccount.mockReturnValueOnce(
      new Promise<never>((_resolve, r) => {
        reject = r;
      }),
    );
    await render();
    await openSheet();
    await press('register-sheet-confirm');
    tree.unmount();
    await ReactTestRenderer.act(async () => {
      reject(new Error('offline'));
    });
    expect(onRegistered).not.toHaveBeenCalled();
  });
});
