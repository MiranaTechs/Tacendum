/**
 * The duress hand-off: every reset the decoy needs, called from one place.
 *
 * WHAT THIS PINS. `App.tsx`'s duress arm is the only moment at which a decoy
 * session is told to show the shipped defaults rather than the owner's
 * settings (rule 16). It called SIX resets — screen security, read receipts,
 * typing indicators, the preview level, always-relay and silence-unknown —
 * and two modules that own the same kind of state were missing from the list:
 * push consent, which had no reset at all, and Field Mode, whose
 * `resetFieldModeForDuress()` shipped exported with no caller.
 *
 * WHY THIS FILE EXISTS RATHER THAN AN ASSERTION IN `fieldMode.test.ts`. That
 * suite's `resetFieldModeForDuress clears the shadow, the App.tsx handoff`
 * case calls the function DIRECTLY, so it is green whether or not App.tsx
 * ever calls it — it pins the function, not the hand-off. The hand-off can
 * only be pinned where the transition happens, which is here.
 *
 * The list is asserted as a WHOLE, not two additions: a reset that goes
 * missing later is the same defect as one that was never added, and it fails
 * the same way — silently, in the one session nobody can re-run.
 *
 * FALSIFIERS, run at authoring time and restored (CONTRIBUTING.md:76-80):
 * delete `resetPushConsentForDuress()` from the block and BOTH cases fail —
 * the eight-way comparison reports `pushConsent: 0`, and the second coercion
 * opens on the previous coercer's Off; delete `resetFieldModeForDuress()` and
 * the comparison alone fails, reporting `fieldMode: 0`. Before the two lines
 * landed this file was 2 of 2 red with the other six already at 1 each, which
 * is what says the harness reaches the block rather than missing it.
 *
 * Harness copied from `App.lock.test.tsx`, which is the file that proved a
 * reversed code opens the decoy without touching the real world.
 */

jest.mock('../src/ws', () => {
  const handlers: {
    frame?: (f: unknown) => void;
    state?: (s: string) => void;
  } = {};
  const calls = {
    start: jest.fn(),
    stop: jest.fn(),
    send: jest.fn((_frame: unknown) => true),
  };
  class WsClient {
    onFrame(cb: (f: unknown) => void) {
      handlers.frame = cb;
    }
    onState(cb: (s: string) => void) {
      handlers.state = cb;
    }
    start(token: string) {
      calls.start(token);
    }
    stop() {
      calls.stop();
    }
    send(frame: unknown) {
      return calls.send(frame) as boolean;
    }
    get isOpen() {
      return false;
    }
  }
  return { WsClient, __ws: { handlers, calls } };
});

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import App from '../App';
import * as calling from '../src/call';
import * as db from '../src/db';
import * as fieldMode from '../src/fieldMode';
import { messaging } from '../src/messaging';
import * as previews from '../src/previews';
import * as pushConsent from '../src/pushConsent';
import * as readReceipts from '../src/readReceipts';
import { screenSecurity } from '../src/screenSecurity';
import { session } from '../src/session';
import * as typingIndicators from '../src/typingIndicators';

interface FakeDb {
  name: string;
  execute: jest.Mock;
  close: jest.Mock;
}
const sqlite = (
  jest.requireMock('@op-engineering/op-sqlite') as {
    __sqlite: {
      opened: string[];
      instances: Map<string, FakeDb>;
      reset: () => void;
    };
  }
).__sqlite;
const crypto = jest.requireMock('tacendum-crypto') as {
  __keychain: Map<string, string>;
  encryptText: jest.Mock;
};

const mounted: ReactTestRenderer.ReactTestRenderer[] = [];

const realFetch = globalThis.fetch;
const fetchMock = jest.fn(async () => ({
  ok: true,
  status: 200,
  json: async () => ({}),
  text: async () => '',
}));
afterAll(() => {
  globalThis.fetch = realFetch;
});

async function renderApp(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<App />);
  });
  mounted.push(tree);
  return tree;
}

async function press(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): Promise<void> {
  await ReactTestRenderer.act(async () => {
    tree.root.findByProps({ testID }).props.onPress();
  });
}

/** Seed a decoy workspace the boot can land in. */
function installDecoy(): void {
  const decoyProfile = [
    { key: 'userId', value: 'ME-ULID' },
    { key: 'registrationId', value: '7' },
    { key: 'displayName', value: 'Me' },
    { key: 'about', value: '' },
    { key: 'avatarB64', value: '' },
    { key: 'profileVersion', value: '1' },
  ];
  sqlite.instances.set('tacendum-decoy.sqlite', {
    name: 'tacendum-decoy.sqlite',
    execute: jest.fn(async (sql: string) => {
      const s = String(sql);
      if (s.includes('FROM profile')) return { rows: decoyProfile };
      if (s.includes('PRAGMA table_info(attachments')) {
        return { rows: [{ name: 'direction' }] };
      }
      if (s.includes('PRAGMA table_info(reactions')) {
        return { rows: [{ name: 'targetDirection' }, { name: 'reactorId' }] };
      }
      if (s.includes('PRAGMA table_info(pending_revisions')) {
        return { rows: [{ name: 'writerId' }] };
      }
      return { rows: [] };
    }),
    close: jest.fn(),
  });
}

beforeEach(async () => {
  messaging.stop();
  calling.resetCallingForTests();
  await db.close();
  db.setWorkspace('real');
  session.setMode('real');
  crypto.__keychain.clear();
  (crypto as unknown as { hasIdentity: jest.Mock }).hasIdentity.mockResolvedValue(
    true,
  );
  sqlite.reset();
  fetchMock.mockClear();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(async () => {
  await ReactTestRenderer.act(async () => {
    while (mounted.length) mounted.pop()!.unmount();
    (crypto as unknown as { hasIdentity: jest.Mock }).hasIdentity.mockResolvedValue(
      false,
    );
  });
  jest.restoreAllMocks();
  session.setMode('real');
});

/** Open the decoy the way a coerced person does: the code, reversed. */
async function unlockUnderDuress(): Promise<void> {
  crypto.__keychain.set('lock.enabled', '1');
  crypto.__keychain.set('lock.passcode', '123456');
  crypto.__keychain.set('authToken', 'real-owner-token');
  installDecoy();
  const tree = await renderApp();
  for (const key of ['6', '5', '4', '3', '2', '1']) {
    await press(tree, `pin-key-${key}`);
  }
  await press(tree, 'pin-submit');
}

test('the duress arm calls every reset the decoy needs, all eight', async () => {
  const spies = {
    screenSecurity: jest.spyOn(screenSecurity, 'resetForDuress'),
    readReceipts: jest.spyOn(readReceipts, 'resetReadReceiptsForDuress'),
    typingIndicators: jest.spyOn(
      typingIndicators,
      'resetTypingIndicatorsForDuress',
    ),
    previews: jest.spyOn(previews, 'resetPreviewLevelForDuress'),
    alwaysRelay: jest.spyOn(calling, 'resetAlwaysRelayForDuress'),
    silenceUnknown: jest.spyOn(calling, 'resetSilenceUnknownCallersForDuress'),
    pushConsent: jest.spyOn(pushConsent, 'resetPushConsentForDuress'),
    fieldMode: jest.spyOn(fieldMode, 'resetFieldModeForDuress'),
  };

  await unlockUnderDuress();

  expect(session.mode).toBe('duress');
  const called = Object.fromEntries(
    Object.entries(spies).map(([name, spy]) => [name, spy.mock.calls.length]),
  );
  expect(called).toEqual({
    screenSecurity: 1,
    readReceipts: 1,
    typingIndicators: 1,
    previews: 1,
    alwaysRelay: 1,
    silenceUnknown: 1,
    pushConsent: 1,
    fieldMode: 1,
  });
});

test('a second coercion does not inherit the first coercer’s push row', async () => {
  // The behavioural half of the push line, and the reason it is worth a
  // reset rather than only a reader branch: the shadow is process state, so
  // without this call the row a coercer left Off is the row the next coerced
  // session opens on — and Off in that row says the owner's phone has already
  // stopped being wakeable.
  session.setMode('duress');
  await pushConsent.setPushTokensAllowed(false);
  expect(pushConsent.pushTokensAllowed()).toBe(false);
  session.setMode('real');

  await unlockUnderDuress();

  expect(session.mode).toBe('duress');
  expect(pushConsent.pushTokensAllowed()).toBe(true);
});
