import { setSecret } from 'tacendum-crypto';
import * as calling from '../src/call';
import {
  FIELD_MODE_SNAPSHOT_KEY,
  FIELD_VALUES,
  SHIPPED_DEFAULTS,
  applyFieldMode,
  clearFieldMode,
  decodeSnapshot,
  encodeSnapshot,
  fieldModeActive,
  fieldModeDuressRows,
  recordFieldModeDuressRows,
  resetFieldModeForDuress,
  resetFieldModeForTests,
  setFieldMode,
  type FieldModeDeps,
  type FieldModeState,
} from '../src/fieldMode';
import { loadPreviewLevel } from '../src/previews';
import { screenSecurity } from '../src/screenSecurity';
import { session } from '../src/session';

/**
 * FIELD MODE, the module (app/src/fieldMode.ts).
 *
 * Four properties this suite exists to hold, in the order they matter:
 *
 *  1. the state is DERIVED — there is no stored flag, so a partial apply or a
 *     hand-changed row reads back honestly as Off;
 *  2. the SNAPSHOT is written and awaited before any setter runs, so the
 *     row's promise to restore is true before anything is overwritten;
 *  3. Off always completes — a missing or garbage snapshot lands on the
 *     shipped defaults rather than throwing at a person who is trying to put
 *     their settings back;
 *  4. DURESS writes NOTHING, and LOOKS THE SAME. Two halves, and neither is
 *     optional: `setPreviewLevel`, `setAlwaysRelay` and
 *     `setSilenceUnknownCallers` are not duress-guarded themselves, so
 *     without the guard here one coerced tap would rewrite four of the
 *     owner's real settings — and a guard that flipped the chip while the
 *     rows it describes sat still would be a rule-16 tell, reachable in two
 *     taps with the row's own consent line as the instructions.
 */

// src/call reaches the API client at construction time; the Settings suites
// mock it for the same reason.
jest.mock('../src/api', () => ({
  apiDeletePushToken: jest.fn(async () => undefined),
  apiRegisterPushToken: jest.fn(async () => undefined),
  apiTurnCredentials: jest.fn(async () => ({ iceServers: [], ttlSeconds: 3600 })),
}));

const crypto = jest.requireMock('tacendum-crypto') as {
  __keychain: Map<string, string>;
  __sharedState: Map<string, string>;
};

/** A state with every mapped control at its field value, App Lock on. */
function fieldState(patch: Partial<FieldModeState> = {}): FieldModeState {
  return {
    previewLevel: FIELD_VALUES.previewLevel,
    relayEveryCall: FIELD_VALUES.relayEveryCall,
    silenceUnknownCallers: FIELD_VALUES.silenceUnknownCallers,
    blankWhileCaptured: FIELD_VALUES.blankWhileCaptured,
    lockEnabled: true,
    autolockSec: FIELD_VALUES.autolockSec,
    ...patch,
  };
}

/** A state with nothing at its field value, App Lock on. */
function plainState(patch: Partial<FieldModeState> = {}): FieldModeState {
  return {
    previewLevel: 'sender',
    relayEveryCall: false,
    silenceUnknownCallers: false,
    blankWhileCaptured: false,
    lockEnabled: true,
    autolockSec: 300,
    ...patch,
  };
}

interface Recorder {
  deps: FieldModeDeps;
  /** Every seam call, in order, as `name` or `name:value`. */
  log: string[];
  state: FieldModeState;
  snapshot: string | null;
}

function recorder(
  initial: FieldModeState,
  overrides: Partial<FieldModeDeps> = {},
): Recorder {
  const rec: Recorder = {
    log: [],
    state: { ...initial },
    snapshot: null,
    deps: {} as FieldModeDeps,
  };
  rec.deps = {
    readState: async () => {
      rec.log.push('readState');
      return { ...rec.state };
    },
    applyPreviewLevel: async level => {
      rec.log.push(`preview:${level}`);
      rec.state.previewLevel = level;
    },
    applyRelayEveryCall: async on => {
      rec.log.push(`relay:${String(on)}`);
      rec.state.relayEveryCall = on;
    },
    applySilenceUnknownCallers: async on => {
      rec.log.push(`silence:${String(on)}`);
      rec.state.silenceUnknownCallers = on;
    },
    applyBlankWhileCaptured: async on => {
      rec.log.push(`blank:${String(on)}`);
      rec.state.blankWhileCaptured = on;
    },
    applyAutolockSec: async sec => {
      rec.log.push(`autolock:${String(sec)}`);
      rec.state.autolockSec = sec;
    },
    readSnapshot: async () => {
      rec.log.push('readSnapshot');
      return rec.snapshot;
    },
    writeSnapshot: async value => {
      rec.log.push('writeSnapshot');
      rec.snapshot = value;
    },
    deleteSnapshot: async () => {
      rec.log.push('deleteSnapshot');
      rec.snapshot = null;
    },
    ...overrides,
  };
  return rec;
}

beforeEach(async () => {
  crypto.__keychain.clear();
  crypto.__sharedState.clear();
  jest.clearAllMocks();
  session.setMode('real');
  resetFieldModeForTests();
  calling.resetCallingForTests();
  await loadPreviewLevel();
  await calling.loadAlwaysRelay();
  await calling.loadSilenceUnknownCallers();
  screenSecurity.blankEnabled = true;
});

afterEach(() => {
  session.setMode('real');
  resetFieldModeForTests();
});

describe('the derived predicate', () => {
  it('is On only when every mapped control is at its field value', () => {
    expect(fieldModeActive(fieldState())).toBe(true);
    expect(fieldModeActive(plainState())).toBe(false);
    expect(fieldModeActive({ ...fieldState(), previewLevel: 'sender' })).toBe(false);
    expect(fieldModeActive({ ...fieldState(), previewLevel: 'full' })).toBe(false);
    expect(fieldModeActive({ ...fieldState(), relayEveryCall: false })).toBe(false);
    expect(fieldModeActive({ ...fieldState(), silenceUnknownCallers: false })).toBe(
      false,
    );
    expect(fieldModeActive({ ...fieldState(), blankWhileCaptured: false })).toBe(
      false,
    );
  });

  it('drops the auto-lock term when App Lock is off and counts it when on', () => {
    // App Lock ON: a non-zero auto-lock is a genuine miss.
    expect(fieldModeActive({ ...fieldState(), autolockSec: 60 })).toBe(false);
    // App Lock OFF: the setting is inert and its row is not even rendered, so
    // Field Mode still reads On.
    expect(
      fieldModeActive({ ...fieldState(), lockEnabled: false, autolockSec: 300 }),
    ).toBe(true);
  });

  it('has no screenshot term — there is no control to be one', () => {
    // Nothing in the field table names screenshots or disclosure, and the
    // state a caller must supply carries no such field either.
    expect(Object.keys(FIELD_VALUES).sort()).toEqual([
      'autolockSec',
      'blankWhileCaptured',
      'previewLevel',
      'relayEveryCall',
      'silenceUnknownCallers',
    ]);
    expect(Object.keys(fieldState()).some(k => /shot|capture$|disclos/i.test(k))).toBe(
      false,
    );
  });
});

describe('the snapshot codec', () => {
  it('round-trips, and records null auto-lock when App Lock is off', () => {
    const s = plainState();
    expect(decodeSnapshot(encodeSnapshot(s))).toEqual({
      v: 1,
      previewLevel: 'sender',
      relayEveryCall: false,
      silenceUnknownCallers: false,
      blankWhileCaptured: false,
      autolockSec: 300,
    });
    expect(
      decodeSnapshot(encodeSnapshot({ ...s, lockEnabled: false }))?.autolockSec,
    ).toBeNull();
  });

  it('treats anything it did not write as absent, never as a throw', () => {
    expect(decodeSnapshot(null)).toBeNull();
    expect(decodeSnapshot('')).toBeNull();
    expect(decodeSnapshot('{')).toBeNull();
    expect(decodeSnapshot('"a string"')).toBeNull();
    expect(decodeSnapshot(JSON.stringify({ v: 2, previewLevel: 'none' }))).toBeNull();
    expect(
      decodeSnapshot(JSON.stringify({ ...JSON.parse(encodeSnapshot(plainState())), previewLevel: 'loud' })),
    ).toBeNull();
    expect(
      decodeSnapshot(JSON.stringify({ ...JSON.parse(encodeSnapshot(plainState())), relayEveryCall: 'yes' })),
    ).toBeNull();
  });

  it('refuses an auto-lock the Auto-lock row could not display', () => {
    // Every other field is checked against its exact domain; this one has to
    // be too, or Off writes a deadline no chip can show and App.tsx's relock
    // arithmetic gets a number nobody chose.
    for (const sec of [-1, 3.5, 86400, 61]) {
      expect(
        decodeSnapshot(
          JSON.stringify({ ...JSON.parse(encodeSnapshot(plainState())), autolockSec: sec }),
        ),
      ).toBeNull();
    }
    for (const sec of [0, 60, 300]) {
      expect(
        decodeSnapshot(
          JSON.stringify({ ...JSON.parse(encodeSnapshot(plainState())), autolockSec: sec }),
        )?.autolockSec,
      ).toBe(sec);
    }
  });
});

describe('applyFieldMode', () => {
  it('writes the snapshot BEFORE any setter, then moves every mapped control', async () => {
    const rec = recorder(plainState());
    const after = await applyFieldMode(rec.deps);

    expect(rec.log[0]).toBe('readState');
    expect(rec.log[1]).toBe('writeSnapshot');
    expect(rec.log.slice(2)).toEqual([
      'preview:none',
      'relay:true',
      'silence:true',
      'blank:true',
      'autolock:0',
    ]);
    expect(fieldModeActive(rec.state)).toBe(true);
    expect(fieldModeActive(after)).toBe(true);
    expect(decodeSnapshot(rec.snapshot)).toEqual({
      v: 1,
      previewLevel: 'sender',
      relayEveryCall: false,
      silenceUnknownCallers: false,
      blankWhileCaptured: false,
      autolockSec: 300,
    });
  });

  it('leaves auto-lock alone when App Lock is off, and still reads On', async () => {
    const rec = recorder(plainState({ lockEnabled: false, autolockSec: 300 }));
    const after = await applyFieldMode(rec.deps);
    expect(rec.log).not.toContain('autolock:0');
    expect(rec.state.autolockSec).toBe(300);
    expect(fieldModeActive(after)).toBe(true);
  });

  it('a snapshot write that throws leaves every setting untouched', async () => {
    const before = plainState();
    const rec = recorder(before, {
      writeSnapshot: async () => {
        throw new Error('store refused');
      },
    });
    await expect(applyFieldMode(rec.deps)).rejects.toThrow('store refused');
    expect(rec.state).toEqual(before);
    expect(rec.snapshot).toBeNull();
    expect(rec.log).toEqual(['readState']);
  });

  it('a setter that throws mid-apply rolls back, and the derived read says Off', async () => {
    const before = plainState();
    const rec = recorder(before, {
      applySilenceUnknownCallers: async () => {
        throw new Error('keychain refused');
      },
    });
    await expect(applyFieldMode(rec.deps)).rejects.toThrow('keychain refused');
    // The two setters that had already run are put back…
    expect(rec.state.previewLevel).toBe('sender');
    expect(rec.state.relayEveryCall).toBe(false);
    // …and nothing after the throw ever ran.
    expect(rec.state.blankWhileCaptured).toBe(false);
    expect(rec.state.autolockSec).toBe(300);
    // Derived: whatever happened, the row reads honestly.
    expect(fieldModeActive(rec.state)).toBe(false);
    expect(rec.snapshot).toBeNull();
  });

  it('rolls back the setter that ITSELF threw, mirror first', async () => {
    // Every real setter moves its module's in-memory mirror BEFORE it
    // persists (previews.ts `level = next` then writeSharedState;
    // call/index.ts `alwaysRelay = on` then setSecret; screenSecurity.ts
    // `this.blankEnabled = enabled` then setSecret). So the setter that
    // rejects is exactly the one that has already half-applied. If its undo
    // is registered only after the await, nothing puts the mirror back — and
    // Settings then claims the field value over a store that never took it,
    // which is the one direction previews.ts says must never happen.
    const rec = recorder(plainState());
    rec.deps.applyPreviewLevel = async level => {
      rec.log.push(`preview:${level}`);
      rec.state.previewLevel = level; // mirror moves…
      throw new Error('container unavailable'); // …then the write refuses.
    };
    await expect(applyFieldMode(rec.deps)).rejects.toThrow('container unavailable');
    expect(rec.state).toEqual(plainState());
    expect(fieldModeActive(rec.state)).toBe(false);
  });

  it('a second On does not overwrite the record of what was there first', async () => {
    // Without the `fieldModeActive(before)` guard, a redundant tap would
    // snapshot the FIELD values — after which Off would "restore" them and
    // the switch could never be turned off again.
    const rec = recorder(plainState());
    await applyFieldMode(rec.deps);
    const first = rec.snapshot;
    await applyFieldMode(rec.deps);
    expect(rec.snapshot).toBe(first);
    expect(decodeSnapshot(rec.snapshot)?.previewLevel).toBe('sender');
    await clearFieldMode(rec.deps);
    expect(rec.state).toEqual(plainState());
  });
});

describe('clearFieldMode', () => {
  it('restores each snapshotted value and deletes the snapshot key', async () => {
    const rec = recorder(plainState());
    await applyFieldMode(rec.deps);
    rec.log.length = 0;

    const restored = await clearFieldMode(rec.deps);
    expect(rec.state).toEqual(plainState());
    expect(restored.previewLevel).toBe('sender');
    expect(restored.relayEveryCall).toBe(false);
    expect(restored.silenceUnknownCallers).toBe(false);
    expect(restored.blankWhileCaptured).toBe(false);
    expect(restored.autolockSec).toBe(300);
    expect(rec.snapshot).toBeNull();
    expect(rec.log).toContain('deleteSnapshot');
    expect(fieldModeActive(rec.state)).toBe(false);
  });

  it('a missing snapshot restores the shipped defaults and never throws', async () => {
    // autolockSec 300, NOT the field value: with 0 on both sides the
    // "left alone" assertion below could not fail in the direction it guards.
    const rec = recorder(fieldState({ autolockSec: 300 }));
    rec.snapshot = null;
    await expect(clearFieldMode(rec.deps)).resolves.toBeDefined();
    expect(rec.state.previewLevel).toBe(SHIPPED_DEFAULTS.previewLevel);
    expect(rec.state.relayEveryCall).toBe(SHIPPED_DEFAULTS.relayEveryCall);
    expect(rec.state.silenceUnknownCallers).toBe(
      SHIPPED_DEFAULTS.silenceUnknownCallers,
    );
    expect(rec.state.blankWhileCaptured).toBe(SHIPPED_DEFAULTS.blankWhileCaptured);
    // Auto-lock is left where it is: nothing recorded what it was.
    expect(rec.log.some(l => l.startsWith('autolock:'))).toBe(false);
    expect(rec.state.autolockSec).toBe(300);
  });

  it('with no snapshot, Off from hand-set field values lands on the DEFAULTS', async () => {
    // The case the copy deck's ⓘ names, and the reason it has to: the chip is
    // derived, so somebody who chose these four values themselves reads On
    // with nothing recorded anywhere. One tap on Off then rewrites the two
    // they had hardened. The behaviour is right; an unconditional "puts back
    // what was in force" sentence over it would not be.
    const rec = recorder(fieldState({ lockEnabled: false, autolockSec: 300 }));
    expect(fieldModeActive(rec.state)).toBe(true);
    rec.snapshot = null;
    const back = await clearFieldMode(rec.deps);
    expect(back.previewLevel).toBe(SHIPPED_DEFAULTS.previewLevel);
    expect(back.relayEveryCall).toBe(SHIPPED_DEFAULTS.relayEveryCall);
    expect(rec.state.previewLevel).toBe(SHIPPED_DEFAULTS.previewLevel);
    expect(rec.state.relayEveryCall).toBe(false);
  });

  it('reports the auto-lock it actually wrote, not the one the snapshot held', async () => {
    // Apply with App Lock ON (snapshot records 300), then App Lock goes off
    // before Off is tapped. The write is skipped — so the RETURNED state must
    // not claim 300 either, or the screen's `applyRows(settled)` inherits it
    // and `commit()` writes it to the Keychain the next time App Lock is
    // enabled.
    const rec = recorder(plainState());
    await applyFieldMode(rec.deps);
    rec.state.lockEnabled = false;
    rec.state.autolockSec = 0;
    rec.log.length = 0;

    const back = await clearFieldMode(rec.deps);
    expect(back.autolockSec).toBe(0);
    expect(rec.log.some(l => l.startsWith('autolock:'))).toBe(false);
    expect(rec.state.autolockSec).toBe(0);
  });

  it('a garbage snapshot is treated as absent, and a read that throws too', async () => {
    const rec = recorder(fieldState());
    rec.snapshot = 'not json at all';
    await clearFieldMode(rec.deps);
    expect(rec.state.previewLevel).toBe(SHIPPED_DEFAULTS.previewLevel);

    const rec2 = recorder(fieldState(), {
      readSnapshot: async () => {
        throw new Error('unreadable');
      },
    });
    await expect(clearFieldMode(rec2.deps)).resolves.toBeDefined();
    expect(rec2.state.previewLevel).toBe(SHIPPED_DEFAULTS.previewLevel);
  });

  it('keeps the snapshot when a restore setter refuses, so Off can be retried', async () => {
    const rec = recorder(plainState());
    await applyFieldMode(rec.deps);
    const kept = rec.snapshot;
    const failing = recorder(rec.state, {
      applyPreviewLevel: async () => {
        throw new Error('file refused');
      },
    });
    failing.snapshot = kept;
    await expect(clearFieldMode(failing.deps)).rejects.toThrow('file refused');
    expect(failing.snapshot).toBe(kept);
  });
});

describe('duress (rule 16) — the guard the underlying setters do not have', () => {
  it('a coerced tap writes NOTHING and lands on the same five values a real tap does', async () => {
    // The owner's real settings, as a real session left them.
    await setSecret('tacendum.alwaysRelay', '1');
    await setSecret('tacendum.silenceUnknownCallers', '0');
    await setSecret('screensec.blank', '0');
    crypto.__sharedState.set('preview-level', 'full');
    await loadPreviewLevel();
    await calling.loadAlwaysRelay();
    await calling.loadSilenceUnknownCallers();

    session.setMode('duress');
    const keychainBefore = [...crypto.__keychain.entries()].sort();
    const sharedBefore = [...crypto.__sharedState.entries()].sort();

    // The decoy's own rows, as App.tsx's duress block leaves them: nothing
    // recorded yet, and the derived chip therefore reads Off.
    const decoy = plainState({ silenceUnknownCallers: true, blankWhileCaptured: true });
    expect(fieldModeDuressRows()).toBeNull();
    expect(fieldModeActive(decoy)).toBe(false);

    // A coerced tap returns the SAME five values a real one lands on — the
    // row's own consent line names four of them, so a coercer who can read
    // the screen can check.
    const shown = await setFieldMode(true, decoy);
    expect(shown).toEqual({
      previewLevel: 'none',
      relayEveryCall: true,
      silenceUnknownCallers: true,
      blankWhileCaptured: true,
      lockEnabled: true,
      autolockSec: 0,
    });
    expect(fieldModeActive(shown)).toBe(true);
    // …and the shadow holds them, which is what survives a Settings remount.
    expect(fieldModeDuressRows()).toEqual({
      previewLevel: 'none',
      relayEveryCall: true,
      silenceUnknownCallers: true,
      blankWhileCaptured: true,
    });

    // Off puts back what the coerced On found, auto-lock included.
    const back = await setFieldMode(false, shown);
    expect(back.previewLevel).toBe('sender');
    expect(back.relayEveryCall).toBe(false);
    expect(back.autolockSec).toBe(300);
    expect(fieldModeActive(back)).toBe(false);

    // NOT ONE BYTE moved — no setting, and no snapshot key either.
    expect([...crypto.__keychain.entries()].sort()).toEqual(keychainBefore);
    expect([...crypto.__sharedState.entries()].sort()).toEqual(sharedBefore);
    expect(crypto.__keychain.has(FIELD_MODE_SNAPSHOT_KEY)).toBe(false);

    // The next real session sees the owner's untouched values.
    session.setMode('real');
    await loadPreviewLevel();
    await calling.loadAlwaysRelay();
    await calling.loadSilenceUnknownCallers();
    expect(crypto.__sharedState.get('preview-level')).toBe('full');
    expect(calling.alwaysRelayEnabled()).toBe(true);
    expect(calling.silenceUnknownCallersEnabled()).toBe(false);
    expect(crypto.__keychain.get('screensec.blank')).toBe('0');
  });

  it('a coerced Off with nothing recorded lands on the shipped defaults', async () => {
    // The same fallback `clearFieldMode` takes with no snapshot, so the decoy
    // and the owner cannot be told apart by where Off lands either.
    session.setMode('duress');
    const back = await setFieldMode(false, fieldState({ lockEnabled: false }));
    expect(back.previewLevel).toBe(SHIPPED_DEFAULTS.previewLevel);
    expect(back.relayEveryCall).toBe(SHIPPED_DEFAULTS.relayEveryCall);
    expect(back.silenceUnknownCallers).toBe(SHIPPED_DEFAULTS.silenceUnknownCallers);
    expect(back.blankWhileCaptured).toBe(SHIPPED_DEFAULTS.blankWhileCaptured);
  });

  it('a hand-changed row is remembered too, so the chip cannot come back On over it', async () => {
    session.setMode('duress');
    await setFieldMode(true, plainState());
    // The screen records every row that moves, not only the Field Mode tap.
    recordFieldModeDuressRows({
      previewLevel: 'sender',
      relayEveryCall: true,
      silenceUnknownCallers: true,
      blankWhileCaptured: true,
    });
    const rows = fieldModeDuressRows()!;
    expect(rows.previewLevel).toBe('sender');
    expect(fieldModeActive({ ...rows, lockEnabled: false, autolockSec: 0 })).toBe(
      false,
    );
  });

  it('the shadow resets on the next mode change, with or without an App.tsx hook', async () => {
    session.setMode('duress');
    await setFieldMode(true, plainState());
    expect(fieldModeDuressRows()).not.toBeNull();
    // A real session in between never sees it…
    session.setMode('real');
    expect(fieldModeDuressRows()).toBeNull();
    // …and the next coerced session starts from the decoy's own rows again.
    session.setMode('duress');
    expect(fieldModeDuressRows()).toBeNull();
  });

  it('resetFieldModeForDuress clears the shadow, the App.tsx handoff', async () => {
    session.setMode('duress');
    await setFieldMode(true, plainState());
    expect(fieldModeDuressRows()).not.toBeNull();
    resetFieldModeForDuress();
    expect(fieldModeDuressRows()).toBeNull();
  });

  it('recordFieldModeDuressRows is a no-op in a real session', () => {
    recordFieldModeDuressRows({
      previewLevel: 'none',
      relayEveryCall: true,
      silenceUnknownCallers: true,
      blankWhileCaptured: true,
    });
    expect(fieldModeDuressRows()).toBeNull();
  });

  it('a real session still applies and restores through the real store', async () => {
    const rec = recorder(plainState());
    await setFieldMode(true, plainState(), rec.deps);
    expect(fieldModeActive(rec.state)).toBe(true);
    await setFieldMode(false, rec.state, rec.deps);
    expect(rec.state).toEqual(plainState());
  });
});
