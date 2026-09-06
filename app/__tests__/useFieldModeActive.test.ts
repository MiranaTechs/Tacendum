/**
 * `useFieldModeActive` — Field Mode's answer, at a second address.
 *
 * A repo-wide grep found `fieldMode` in exactly three files before this:
 * the module, its copy deck, and the Settings screen. A setting somebody
 * turned on before walking somewhere, and then cannot see, is a setting they
 * are carrying blind.
 *
 * The one rule this hook exists to keep: it is DERIVED, from the same
 * synchronous getters the Settings screen reads, with the same duress
 * precedence — never a stored flag and never a copy. A remembered "on" that
 * disagrees with the settings it describes is the shape that must never
 * ship: it is unreachable in a real session, so it would tell a coercer
 * which session they are in.
 *
 * The lock read is asynchronous, so the hook answers Off until it lands.
 * That is the conservative direction on purpose — a screen never claims a
 * posture before it knows.
 */

import ReactTestRenderer from 'react-test-renderer';
import React from 'react';
import { Text } from 'react-native';
import { setAlwaysRelay, setSilenceUnknownCallers } from '../src/call';
import { FIELD_VALUES, recordFieldModeDuressRows } from '../src/fieldMode';
import * as lock from '../src/lock';
import { setPreviewLevel } from '../src/previews';
import { screenSecurity } from '../src/screenSecurity';
import { session } from '../src/session';
import { useFieldModeActive } from '../src/useFieldModeActive';

const keychain = (
  jest.requireMock('tacendum-crypto') as { __keychain: Map<string, string> }
).__keychain;

/** Mount the hook and report what it answered after its effects settled. */
async function read(): Promise<boolean> {
  let answer = false;
  function Probe() {
    answer = useFieldModeActive();
    return React.createElement(Text, null, String(answer));
  }
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(React.createElement(Probe));
  });
  await ReactTestRenderer.act(async () => {});
  await ReactTestRenderer.act(() => tree.unmount());
  return answer;
}

/** Put the four mapped rows where Field Mode's own conjunction wants them. */
async function applyFieldValues(): Promise<void> {
  await setPreviewLevel(FIELD_VALUES.previewLevel);
  await setAlwaysRelay(FIELD_VALUES.relayEveryCall);
  await setSilenceUnknownCallers(FIELD_VALUES.silenceUnknownCallers);
  await screenSecurity.setBlankEnabled(FIELD_VALUES.blankWhileCaptured);
}

beforeEach(async () => {
  session.setMode('real');
  keychain.clear();
  await setPreviewLevel('full');
  await setAlwaysRelay(false);
  await setSilenceUnknownCallers(false);
  await screenSecurity.setBlankEnabled(false);
});

afterEach(() => {
  session.setMode('real');
  keychain.clear();
});

describe('the derived answer', () => {
  test('Off while any mapped row is not where Field Mode wants it', async () => {
    await expect(read()).resolves.toBe(false);

    // Three of the four is still Off: the conjunction is the claim.
    await setPreviewLevel(FIELD_VALUES.previewLevel);
    await setAlwaysRelay(FIELD_VALUES.relayEveryCall);
    await setSilenceUnknownCallers(FIELD_VALUES.silenceUnknownCallers);
    await expect(read()).resolves.toBe(false);
  });

  test('On once all four are set, with App Lock off', async () => {
    await applyFieldValues();
    await expect(read()).resolves.toBe(true);
  });

  test('changing one mapped row by hand turns it Off again', async () => {
    await applyFieldValues();
    await expect(read()).resolves.toBe(true);
    await setAlwaysRelay(false);
    await expect(read()).resolves.toBe(false);
  });

  test('with App Lock on, Auto-lock joins the conjunction', async () => {
    await applyFieldValues();
    await lock.setup('482913');
    await lock.setAutolock(300);
    await expect(read()).resolves.toBe(false);

    await lock.setAutolock(FIELD_VALUES.autolockSec);
    await expect(read()).resolves.toBe(true);
  });
});

describe('duress', () => {
  test('a coerced session reads Off, by the derivation Settings uses', async () => {
    // The real owner had it on. The duress arm resets the mapped rows to
    // their defaults before the decoy opens, so the same conjunction over
    // the same getters answers Off — the same fact at a second address, not
    // a new fact, so it adds no discriminator.
    await applyFieldValues();
    await expect(read()).resolves.toBe(true);

    session.setMode('duress');
    await setPreviewLevel('full');
    await setAlwaysRelay(false);
    await setSilenceUnknownCallers(false);
    await screenSecurity.setBlankEnabled(false);
    await expect(read()).resolves.toBe(false);
  });

  test('a coerced session that moved the rows itself reads what its own chip reads', async () => {
    // Rule 16: the coerced tap produces the SAME transition, remembered in
    // the module's session-scoped shadow. This hook must read that shadow —
    // the same one SettingsScreen seeds its rows from — or the home line
    // and the Settings chip would disagree, which is itself a tell.
    session.setMode('duress');
    recordFieldModeDuressRows({
      previewLevel: FIELD_VALUES.previewLevel,
      relayEveryCall: FIELD_VALUES.relayEveryCall,
      silenceUnknownCallers: FIELD_VALUES.silenceUnknownCallers,
      blankWhileCaptured: FIELD_VALUES.blankWhileCaptured,
    });
    await expect(read()).resolves.toBe(true);

    // …and the shadow is what answered, not the store: the underlying
    // getters are still at their defaults.
    session.setMode('real');
    await expect(read()).resolves.toBe(false);
  });
});
