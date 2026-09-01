/**
 * RegisterScreen under the REAL Android Platform — the per-platform pin the
 * copy-divergence discipline requires (the divergence inventory carries the
 * row for every sentence here).
 *
 * RegisterScreen.test.tsx pins the iOS sentences verbatim, and jest's default
 * Platform is iOS, so those pins hold exactly as before. This suite is the
 * Android half of the same contract: the consent-grade sentences a Play
 * reviewer and an Android user actually see, asserted exactly, plus the sweep
 * that the surface never says "iPhone" at any depth of interaction.
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

// A PHONE's screen, explicitly: the copy resolves its device noun via
// deviceNoun.ts (sw600dp over the SCREEN's smaller dimension on Android),
// and the preset's default Dimensions mock (750×1334) would classify as a
// tablet. This suite pins the android-PHONE sentences; tablet renderings are
// pinned per-idiom in device-noun.test.ts.
jest.mock('react-native/Libraries/Utilities/Dimensions', () => ({
  __esModule: true,
  default: {
    get: () => ({ width: 393, height: 852, scale: 3, fontScale: 1 }),
    set: jest.fn(),
    addEventListener: jest.fn(() => ({ remove: jest.fn() })),
  },
}));

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { RegisterScreen } from '../src/screens/RegisterScreen';

jest.mock('../src/registration', () => ({
  createOrRestoreAccount: jest.fn(),
}));

let tree: ReactTestRenderer.ReactTestRenderer;

async function render() {
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <RegisterScreen onBack={jest.fn()} onRegistered={jest.fn()} />,
    );
  });
}

const maybe = (id: string) => tree.root.findAllByProps({ testID: id });
const propOf = (id: string, prop: string) => {
  const node = maybe(id).find(n => n.props[prop] !== undefined);
  if (!node) throw new Error(`no node with testID ${id} carries ${prop}`);
  return node.props[prop];
};

async function press(id: string) {
  await ReactTestRenderer.act(async () => {
    propOf(id, 'onPress')();
  });
}

/** Every string currently on screen, whatever nests it. */
function visibleText(): string {
  return JSON.stringify(tree.toJSON());
}

afterEach(() => {
  tree?.unmount();
  jest.clearAllMocks();
});

describe('the identity screen speaks Android', () => {
  it('leads, states the key fact, and asks for consent in the platform’s words', async () => {
    await render();
    const text = visibleText();
    expect(text).toContain(
      'No account to set up. Your identity is a key — and this phone is about to make it for you.',
    );
    expect(text).toContain('A key, made on this phone');
    expect(text).toContain(
      'I understand: if I lose this phone, my identity can’t be recovered — not even by Tacendum.',
    );
  });

  it('the why-no-recovery ⓘ and the server ⓘ teach in the platform’s words', async () => {
    await render();
    await press('register-info-recovery');
    expect(visibleText()).toContain(
      'If this phone is lost or wiped, you would create a fresh identity and the people you talk to would add you again.',
    );
    await press('register-info-server');
    expect(visibleText()).toContain(
      'The public half of your key, plus one-time keys that let people reach you while this phone is offline. No phone number, no email, no name, nothing from your contacts.',
    );
  });

  it('How this works expands to the Android rows, diagrams captioned THIS PHONE', async () => {
    await render();
    await press('register-explain');
    const text = visibleText();
    expect(text).toContain('IF THIS PHONE IS LOST');
    expect(text).toContain(
      'The key is made here and the private half never leaves this phone. Proving who you are means signing a one-time number from the server — which is why there is no password to steal, guess, or reset.',
    );
    expect(text).toContain(
      'A lost phone is final: any door that could restore an identity would also open for whoever asked convincingly enough. Instead of a recovery desk, what comes next is encrypted backups that only you hold the key to.',
    );
    expect(text).toContain('THIS PHONE');
    expect(text).not.toContain('THIS IPHONE');
  });

  it('the confirm sheet restates in the platform’s words', async () => {
    await render();
    await press('register-consent');
    await press('create-identity');
    expect(visibleText()).toContain(
      'This phone is the only place your identity lives.',
    );
  });

  it('at every depth reached above, the surface never says iPhone', async () => {
    await render();
    expect(visibleText()).not.toContain('iPhone');
    await press('register-info-recovery');
    await press('register-info-server');
    await press('register-explain');
    expect(visibleText()).not.toContain('iPhone');
    await press('register-consent');
    await press('create-identity');
    expect(visibleText()).not.toContain('iPhone');
  });
});
