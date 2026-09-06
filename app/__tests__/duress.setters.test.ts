/**
 * The six ordinary setters a coerced session can
 * reach must move the row and write NOTHING real.
 *
 * WHAT WAS WRONG. Six Settings rows wrote straight through to the store with
 * no `session.mode` branch at all — the Keychain for read receipts, typing
 * indicators, push consent, always-relay and silence-unknown-callers, the App
 * Group file for the preview level. Each already had a
 * `resetXForDuress()` hook that showed the DEFAULT when the decoy opened, so
 * the reading half of rule 16 was done and the writing half was not: a
 * coercer's tap durably changed the owner's real setting, and the owner had
 * no way to know which ones had moved.
 *
 * THE TWO PROPERTIES, ASSERTED PER SETTER.
 * 1. The store keeps the owner's value. Not "eventually restored" — never
 * written, so a phone taken away and never unlocked again still holds it.
 * 2. The row still moves. A guard that also froze the chip would trade one
 * tell for another (rule 16: the coerced tap must look identical), so
 * every case asserts the reader followed the tap.
 * And once, at the end: the owner's value comes back on the next REAL unlock,
 * which is what makes the in-memory move safe to allow.
 *
 * FALSIFIERS, run at authoring time and restored (CONTRIBUTING.md:76-80):
 * - delete the guard from `setReadReceipts`: its two cases fail on the
 * Keychain assertion while the "row still moves" half stays green — the
 * exact shape of the shipped defect;
 * - delete the guard from `setTypingIndicators` (typingIndicators.ts:53):
 * that case fails the same way. Worth naming because an earlier draft of
 * it had BOTH sessions writing `false`, which is green with or without the
 * guard — a case only discriminates when the two values differ;
 * - move `setAlwaysRelay`'s guard BELOW `void applyRelayPolicy()`: only that
 * case's native assertion fails, which is the point of having it;
 * - make the guard return BEFORE the in-memory move (`if (duress) return;`
 * above `enabled = on`): the "row still moves" half of all six fails,
 * which is the tell this change must not introduce.
 */
import * as crypto from 'tacendum-crypto';
import {
  CallRefusedError,
  loadAlwaysRelay,
  alwaysRelayEnabled,
  loadSilenceUnknownCallers,
  resetAlwaysRelayForDuress,
  resetCallingForTests,
  resetSilenceUnknownCallersForDuress,
  setAlwaysRelay,
  setSilenceUnknownCallers,
  silenceUnknownCallersEnabled,
} from '../src/call';
import {
  PREVIEW_LEVEL_FILE,
  loadPreviewLevel,
  previewLevel,
  resetPreviewLevelForDuress,
  setPreviewLevel,
} from '../src/previews';
import {
  loadPushConsent,
  pushTokensAllowed,
  resetPushConsentForDuress,
  setPushTokensAllowed,
} from '../src/pushConsent';
import {
  loadReadReceipts,
  readReceiptsEnabled,
  resetReadReceiptsForDuress,
  setReadReceipts,
} from '../src/readReceipts';
import { session } from '../src/session';
import {
  loadTypingIndicators,
  resetTypingIndicatorsForDuress,
  setTypingIndicators,
  typingIndicatorsEnabled,
} from '../src/typingIndicators';

// `setAlwaysRelay` reaches the controller in a REAL session, and the
// controller reaches TURN credentials. The control half of that case is a
// real write, so the network step is mocked exactly as every other Settings
// suite mocks it rather than left to a fetch that does not exist here.
jest.mock('../src/api', () => ({
  apiDeletePushToken: jest.fn(async () => undefined),
  apiRegisterPushToken: jest.fn(async () => undefined),
  apiTurnCredentials: jest.fn(async () => ({ iceServers: [], ttlSeconds: 3600 })),
}));

const keychain = (crypto as unknown as { __keychain: Map<string, string> })
  .__keychain;
const shared = (crypto as unknown as { __sharedState: Map<string, string> })
  .__sharedState;

/**
 * The native call module. `configure` is what `applyRelayPolicy` reaches, on
 * both of its branches — with credentials cached and without — so it is the
 * observable that says whether a coerced tap touched the ICE policy at all.
 */
const nativeCall = jest.requireMock('tacendum-call') as { configure: jest.Mock };

/**
 * `setAlwaysRelay` fires the native apply WITHOUT awaiting it (`void`), so an
 * assertion made on the next line would see nothing whatever the guard did.
 * 40 microtask turns is the flush this repo uses elsewhere for the same job.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

beforeEach(() => {
  keychain.clear();
  shared.clear();
  session.setMode('real');
  resetReadReceiptsForDuress();
  resetTypingIndicatorsForDuress();
  resetPreviewLevelForDuress();
  resetPushConsentForDuress();
  resetAlwaysRelayForDuress();
  resetSilenceUnknownCallersForDuress();
});

afterEach(() => {
  session.setMode('real');
  resetCallingForTests();
});

/** The owner's session, then the coercer's — the order a real day takes. */
async function asOwnerThenDuress(
  owner: () => Promise<void>,
  coerced: () => Promise<void>,
): Promise<void> {
  session.setMode('real');
  await owner();
  session.setMode('duress');
  await coerced();
}

describe('a coerced tap writes nothing real', () => {
  it('read receipts: the Keychain keeps the owner Off, the row still moves', async () => {
    await asOwnerThenDuress(
      async () => {
        await setReadReceipts(false);
      },
      async () => {
        resetReadReceiptsForDuress(); // the decoy opens showing the default
        await setReadReceipts(false);
      },
    );

    expect(keychain.get('tacendum.readReceipts')).toBe('0');
    expect(readReceiptsEnabled()).toBe(false); // the chip followed the tap

    session.setMode('duress');
    await setReadReceipts(true);
    expect(keychain.get('tacendum.readReceipts')).toBe('0'); // still the owner's
    expect(readReceiptsEnabled()).toBe(true);
  });

  it('typing indicators: same rule, same store', async () => {
    // THE OWNER KEEPS THE DEFAULT AND THE COERCER MOVES OFF IT, which is the
    // reverse of read receipts above and is the whole point of the case: this
    // setting defaults ON, so a coerced tap that also wrote `false` would
    // leave the two sessions writing the same byte and the case would stay
    // green with the guard deleted. It says nothing unless the values differ.
    await asOwnerThenDuress(
      async () => {
        await setReadReceipts(false); // unrelated key, proves the assertion is scoped
        await setTypingIndicators(true);
      },
      async () => {
        resetTypingIndicatorsForDuress(); // the decoy opens showing the default
        await setTypingIndicators(false);
      },
    );

    expect(keychain.get('tacendum.typingIndicators')).toBe('1'); // still the owner's
    expect(typingIndicatorsEnabled()).toBe(false); // the chip followed the tap
    expect(keychain.get('tacendum.readReceipts')).toBe('0'); // and only that key
  });

  it('the preview level: the App Group file keeps what the owner chose', async () => {
    // A FILE, not the Keychain — the notification extension reads it, so a
    // coerced write would change what a banner shows on the owner's own
    // phone long after the session ended.
    await asOwnerThenDuress(
      async () => {
        await setPreviewLevel('none');
      },
      async () => {
        resetPreviewLevelForDuress();
        await setPreviewLevel('full');
      },
    );

    expect(shared.get(PREVIEW_LEVEL_FILE)).toBe('none');
    expect(previewLevel()).toBe('full');
  });

  it('push consent: the Keychain keeps what the owner withdrew', async () => {
    // The sharpest of the six. `setPushTokensAllowed(false)` is what makes a
    // locked phone stop ringing, and the owner would have no reason to look
    // at the row again.
    await asOwnerThenDuress(
      async () => {
        await setPushTokensAllowed(true);
      },
      async () => {
        await setPushTokensAllowed(false);
      },
    );

    expect(keychain.get('tacendum.pushTokens')).toBe('1');
    expect(pushTokensAllowed()).toBe(false); // the chip followed the tap
  });

  it('always-relay: the Keychain keeps the owner Off, and the native module is left alone', async () => {
    // TWO CLAIMS, because the guard sits above the native apply as well as
    // above the Keychain write: `setAlwaysRelay` calls
    // `callController().applyRelayPolicy()`, and reconfiguring the ICE policy
    // on the owner's phone is not a thing a coerced session may do either.
    // Only the second assertion pins WHERE the guard sits; without it the
    // guard could be moved below the apply and nothing would go red.
    nativeCall.configure.mockClear();
    await asOwnerThenDuress(
      async () => {
        await setAlwaysRelay(false);
        await settle();
        // The control, so the assertion below is about the guard rather than
        // about a flush too short to have seen anything: a REAL tap does
        // reach the native module.
        expect(nativeCall.configure).toHaveBeenCalled();
        nativeCall.configure.mockClear();
      },
      async () => {
        resetAlwaysRelayForDuress();
        await setAlwaysRelay(true);
        await settle();
      },
    );

    expect(keychain.get('tacendum.alwaysRelay')).toBe('0');
    expect(alwaysRelayEnabled()).toBe(true);
    expect(nativeCall.configure).not.toHaveBeenCalled();
  });

  it('silence unknown callers: the Keychain keeps the owner On', async () => {
    await asOwnerThenDuress(
      async () => {
        await setSilenceUnknownCallers(true);
      },
      async () => {
        resetSilenceUnknownCallersForDuress();
        await setSilenceUnknownCallers(false);
      },
    );

    expect(keychain.get('tacendum.silenceUnknownCallers')).toBe('1');
    expect(silenceUnknownCallersEnabled()).toBe(false);
  });
});

describe('the next real unlock reads the owner back', () => {
  it('every coerced move is gone once the real session re-loads', async () => {
    // This is what makes moving the in-memory value safe: App.tsx re-reads
    // all five on every REAL unlock (App.tsx:971-983), so a coercer's taps
    // live exactly as long as the session they were made in.
    session.setMode('real');
    await setReadReceipts(false);
    await setTypingIndicators(false);
    await setPreviewLevel('none');
    await setPushTokensAllowed(false);

    session.setMode('duress');
    await setReadReceipts(true);
    await setTypingIndicators(true);
    await setPreviewLevel('full');
    await setPushTokensAllowed(true);

    session.setMode('real');
    await loadReadReceipts();
    await loadTypingIndicators();
    await loadPreviewLevel();
    await loadPushConsent();
    await loadAlwaysRelay();
    await loadSilenceUnknownCallers();

    expect(readReceiptsEnabled()).toBe(false);
    expect(typingIndicatorsEnabled()).toBe(false);
    expect(previewLevel()).toBe('none');
    expect(pushTokensAllowed()).toBe(false);
  });
});

describe('the shared call-policy import', () => {
  it('CallRefusedError is reachable from the call barrel', () => {
    // The class is defined in `call/controller.ts`
    // and no production module outside `src/call/` imports that file; the
    // Calls cluster needs the symbol in App.tsx and must not edit this one.
    // The assertion lives in this file because this cluster owns
    // `call/index.ts` and its other two suites are about push and the
    // duress handoff.
    // Imported at the top of this file from '../src/call', never from
    // '../src/call/controller' — the import path IS the assertion.
    expect(typeof CallRefusedError).toBe('function');
    expect(new CallRefusedError('busy').reason).toBe('busy');
    expect(new CallRefusedError('identity_changed').name).toBe(
      'CallRefusedError',
    );
  });
});
