import { deleteSecret, getSecret, setSecret } from 'tacendum-crypto';
import {
  alwaysRelayEnabled,
  setAlwaysRelay,
  setSilenceUnknownCallers,
  silenceUnknownCallersEnabled,
} from './call';
import * as lock from './lock';
import {
  DEFAULT_PREVIEW_LEVEL,
  previewLevel,
  setPreviewLevel,
  type PreviewLevel,
} from './previews';
import { screenSecurity } from './screenSecurity';
import { session, type SessionMode } from './session';

/**
 * FIELD MODE — one switch that moves the settings a person would otherwise
 * have to find one at a time, before walking into somewhere they would
 * rather not be carrying a chatty phone.
 *
 * WHAT IT IS NOT. It is not a mode, not a workspace, not a state of its own.
 * There is NO stored on/off flag anywhere in this module, and that is the
 * central design decision: an "on" bit can disagree with the settings it
 * claims to describe — a failed write, a hand-edited row, a half-applied
 * batch — and a security control that lies about itself is worse than no
 * control. So Field Mode is DERIVED: `fieldModeActive` is a pure conjunction
 * over the settings themselves. A partial apply reads back honestly as Off,
 * changing one mapped row by hand reads back as Off, and there is nothing to
 * drift.
 *
 * WHAT IT MAPS TO — only controls that exist in THIS build, each already a
 * shipped Settings row on both platforms:
 *
 *   previews.ts `previewLevel`             → 'none'
 *   call/index.ts `alwaysRelay`            → true
 *   call/index.ts `silenceUnknownCallers`  → true
 *   screenSecurity.ts `blankEnabled`       → true
 *   lock.ts `lock.autolockSec`             → 0, ONLY when App Lock is on
 *
 * The auto-lock term drops out of the conjunction when App Lock is off,
 * because with the lock off the setting is inert (App.tsx gates relock on
 * `status.enabled`) and its row is not even rendered. Field Mode still reads
 * On there; the screen says auto-lock is not part of it. Field Mode never
 * enables App Lock itself — that needs the passcode ceremony and
 * `setupDecoy()`, and a switch cannot honestly do those.
 *
 * WHAT IT DELIBERATELY DOES NOT TOUCH.
 *  - Disappearing messages. There is no global control: the timer is agreed
 *    with the peer (`envelope.ts` TimerEnvelope) and the only setter emits an
 *    encrypted envelope to that peer plus a system line in both threads. A
 *    one-switch version would fan network side effects out to every
 *    conversation. Struck by the scope audit, and no row exists for it.
 *  - Screenshots. Nothing to set: disclosure is unconditional on iOS
 *    (`envelope.ts`: "Always sent, never configurable") and Android blocks
 *    capture outright with FLAG_SECURE. Informational copy only.
 *
 * THE SNAPSHOT. Off must put back what was in force, so On writes what it is
 * about to overwrite — and writes it FIRST, awaited, before any setter runs.
 * A snapshot write that fails aborts the whole apply and changes nothing: the
 * row's promise to restore has to be true before anything is overwritten.
 *
 * DURESS (rule 16), and this one is load-bearing rather than ceremonial.
 * Three of the five underlying setters (`setPreviewLevel`, `setAlwaysRelay`,
 * `setSilenceUnknownCallers`) are NOT duress-guarded — they write the owner's
 * real Keychain / App-Group state from a coerced session — so an unguarded
 * Field Mode toggle would rewrite four real settings plus a snapshot in one
 * tap. The guard therefore lives HERE, at the top: in a duress session
 * nothing is read, nothing is written, and no snapshot is taken.
 *
 * But the guard must not become a TELL. Rule 16 forbids any observable
 * asymmetry between a real and a coerced session's Settings behaviour, and
 * the row's own visible consent line names the four rows a real tap moves —
 * so a coerced tap that flipped the chip and left those rows sitting where
 * they were would hand whoever is holding the phone a one-tap discriminator,
 * documented on the same screen. So the coerced tap produces the SAME
 * transition: `setFieldMode` returns the state the rows must now show, the
 * screen moves them, and the session-scoped shadow below is what makes that
 * survive a Settings remount — the `session.lockUi` precedent. In memory,
 * for the life of the session, and not one byte.
 *
 * Nothing in this module logs, prints or puts a preference value into an
 * error (rule 4).
 */

/** The settings Field Mode is a statement about, as one value. */
export interface FieldModeState {
  previewLevel: PreviewLevel;
  relayEveryCall: boolean;
  silenceUnknownCallers: boolean;
  blankWhileCaptured: boolean;
  /** App Lock's own state — not something Field Mode sets, only reads. */
  lockEnabled: boolean;
  autolockSec: number;
}

/** What each mapped control reads when Field Mode is on. */
export const FIELD_VALUES = {
  previewLevel: 'none' as PreviewLevel,
  relayEveryCall: true,
  silenceUnknownCallers: true,
  blankWhileCaptured: true,
  autolockSec: 0,
} as const;

/**
 * The four rows Field Mode SETS unconditionally, without App Lock's own
 * state. Auto-lock is deliberately not one of them: it already has a
 * session-scoped home in `session.lockUi`, which is what the screen re-reads
 * on every mount, so nothing here needs to remember it a second time.
 */
export type FieldModeRows = Pick<
  FieldModeState,
  'previewLevel' | 'relayEveryCall' | 'silenceUnknownCallers' | 'blankWhileCaptured'
>;

/**
 * Where Off lands when there is no usable snapshot — the values a fresh
 * install holds, each taken from the module that owns it rather than
 * re-guessed here.
 */
export const SHIPPED_DEFAULTS: FieldModeRows = {
  previewLevel: DEFAULT_PREVIEW_LEVEL,
  relayEveryCall: false,
  silenceUnknownCallers: true,
  blankWhileCaptured: true,
};

function rowsOf(s: FieldModeState): FieldModeRows {
  return {
    previewLevel: s.previewLevel,
    relayEveryCall: s.relayEveryCall,
    silenceUnknownCallers: s.silenceUnknownCallers,
    blankWhileCaptured: s.blankWhileCaptured,
  };
}

/**
 * The auto-lock values the Auto-lock row actually offers
 * (`SettingsScreen.tsx` `COPY.autolockOptions`). Anything else is not a
 * value this app can have written, so the codec below refuses it rather than
 * handing `lock.setAutolock` a number no chip can display.
 */
const AUTOLOCK_OPTIONS: readonly number[] = [0, 60, 300];

/**
 * The pure predicate. Field Mode is on exactly when every mapped control is
 * at its field value; the auto-lock term applies only when App Lock is on.
 * Screenshots are not a term — there is no control to be a term.
 */
export function fieldModeActive(s: FieldModeState): boolean {
  return (
    s.previewLevel === FIELD_VALUES.previewLevel &&
    s.relayEveryCall === FIELD_VALUES.relayEveryCall &&
    s.silenceUnknownCallers === FIELD_VALUES.silenceUnknownCallers &&
    s.blankWhileCaptured === FIELD_VALUES.blankWhileCaptured &&
    (!s.lockEnabled || s.autolockSec === FIELD_VALUES.autolockSec)
  );
}

// --- the snapshot ------------------------------------------------------------

/**
 * Keychain, like every other preference in this family: it must survive a
 * workspace wipe and it must not sit in the decoy file. Dotted-lowercase and
 * 30 characters, inside `SECRET_KEY = ^[A-Za-z0-9._-]{1,64}$` (Names.kt).
 */
export const FIELD_MODE_SNAPSHOT_KEY = 'tacendum.fieldMode.snapshot';

interface Snapshot {
  v: 1;
  previewLevel: PreviewLevel;
  relayEveryCall: boolean;
  silenceUnknownCallers: boolean;
  blankWhileCaptured: boolean;
  /** null when App Lock was off at apply time — nothing was set, so nothing
   * is put back. */
  autolockSec: number | null;
}

export function encodeSnapshot(s: FieldModeState): string {
  const snapshot: Snapshot = {
    v: 1,
    previewLevel: s.previewLevel,
    relayEveryCall: s.relayEveryCall,
    silenceUnknownCallers: s.silenceUnknownCallers,
    blankWhileCaptured: s.blankWhileCaptured,
    autolockSec: s.lockEnabled ? s.autolockSec : null,
  };
  return JSON.stringify(snapshot);
}

/**
 * Defensive to the point of dullness: anything that is not exactly the shape
 * this module wrote reads as ABSENT, never as a throw at the caller. Off must
 * always be able to complete — a person turning Field Mode off is usually
 * doing it because something changed, and a parse error is not an answer.
 */
export function decodeSnapshot(raw: string | null): Snapshot | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  if (o.v !== 1) return null;
  const level = o.previewLevel;
  if (level !== 'full' && level !== 'sender' && level !== 'none') return null;
  if (typeof o.relayEveryCall !== 'boolean') return null;
  if (typeof o.silenceUnknownCallers !== 'boolean') return null;
  if (typeof o.blankWhileCaptured !== 'boolean') return null;
  const sec = o.autolockSec;
  // Validated against the row's own option set, like every other field here
  // is validated against its exact domain: a snapshot holding -1, 3.5 or
  // 86400 would be written straight back through `lock.setAutolock`, after
  // which the Auto-lock row renders with no chip selected and the relock
  // arithmetic in App.tsx gets a deadline nobody chose. Out of domain reads
  // as ABSENT, so Off leaves auto-lock alone.
  if (sec !== null && (typeof sec !== 'number' || !AUTOLOCK_OPTIONS.includes(sec))) {
    return null;
  }
  return {
    v: 1,
    previewLevel: level,
    relayEveryCall: o.relayEveryCall,
    silenceUnknownCallers: o.silenceUnknownCallers,
    blankWhileCaptured: o.blankWhileCaptured,
    autolockSec: sec,
  };
}

// --- the seams ---------------------------------------------------------------

/**
 * Every read and write Field Mode performs, injected.
 *
 * Not for testability alone: it is also what keeps the five modules Field
 * Mode governs free of any edge back to this one. The default wiring below is
 * the only place their names appear.
 */
export interface FieldModeDeps {
  readState(): Promise<FieldModeState>;
  applyPreviewLevel(level: PreviewLevel): Promise<void>;
  applyRelayEveryCall(on: boolean): Promise<void>;
  applySilenceUnknownCallers(on: boolean): Promise<void>;
  applyBlankWhileCaptured(on: boolean): Promise<void>;
  applyAutolockSec(sec: number): Promise<void>;
  readSnapshot(): Promise<string | null>;
  writeSnapshot(value: string): Promise<void>;
  deleteSnapshot(): Promise<void>;
}

export const defaultFieldModeDeps: FieldModeDeps = {
  async readState(): Promise<FieldModeState> {
    const status = await lock.status();
    return {
      previewLevel: previewLevel(),
      relayEveryCall: alwaysRelayEnabled(),
      silenceUnknownCallers: silenceUnknownCallersEnabled(),
      blankWhileCaptured: screenSecurity.blankEnabled,
      lockEnabled: status.enabled,
      autolockSec: status.autolockSec,
    };
  },
  applyPreviewLevel: (level: PreviewLevel) => setPreviewLevel(level),
  applyRelayEveryCall: (on: boolean) => setAlwaysRelay(on),
  applySilenceUnknownCallers: (on: boolean) => setSilenceUnknownCallers(on),
  applyBlankWhileCaptured: (on: boolean) => screenSecurity.setBlankEnabled(on),
  applyAutolockSec: (sec: number) => lock.setAutolock(sec),
  readSnapshot: () => getSecret(FIELD_MODE_SNAPSHOT_KEY),
  writeSnapshot: (value: string) => setSecret(FIELD_MODE_SNAPSHOT_KEY, value),
  deleteSnapshot: () => deleteSecret(FIELD_MODE_SNAPSHOT_KEY),
};

// --- apply and restore -------------------------------------------------------

/**
 * Turn every mapped control to its field value, having first written down
 * what they held.
 *
 * Order is the contract: read, then SNAPSHOT (awaited), then set. If the
 * snapshot write throws, nothing has been touched and the throw reaches the
 * caller with every setting where it was. If a setter throws part-way, the
 * setters that already ran are put back from the in-memory snapshot and the
 * throw is re-raised; because the state is derived, even a rollback that
 * itself half-fails simply reads back as Off rather than as a lie.
 *
 * Returns the state the controls now hold, so the caller's optimistic rows
 * can be reconciled against what actually happened rather than what was
 * hoped for.
 */
export async function applyFieldMode(
  deps: FieldModeDeps = defaultFieldModeDeps,
): Promise<FieldModeState> {
  const before = await deps.readState();
  // Already on? Then this tap is a no-op that must NOT overwrite the record of
  // what the settings were before Field Mode touched them — otherwise Off
  // would restore the field values and the switch could never be turned off.
  if (!fieldModeActive(before)) {
    await deps.writeSnapshot(encodeSnapshot(before));
  }

  const undo: Array<() => Promise<void>> = [];
  try {
    // EVERY undo is registered BEFORE its setter is awaited, and that order is
    // the whole point: each of these setters moves its module's in-memory
    // mirror FIRST and persists SECOND (previews.ts `level = next` then
    // writeSharedState; call/index.ts `alwaysRelay = on` then setSecret;
    // screenSecurity.ts `this.blankEnabled = enabled` then setSecret). So the
    // setter that REJECTS is precisely the one that has already half-applied,
    // and registering its undo afterwards would leave the mirror at the field
    // value with nothing to put it back — the screen would then claim
    // "notifications show nothing" over a file that still says "sender",
    // which is the one direction previews.ts says must never happen. An undo
    // for a setter that never ran is a harmless re-write of the value already
    // in place.
    //
    // Written unconditionally rather than only where the value differs: after
    // this the field values are on disk explicitly, not inherited from a
    // default that a later release could change under someone.
    undo.push(() => deps.applyPreviewLevel(before.previewLevel));
    await deps.applyPreviewLevel(FIELD_VALUES.previewLevel);

    undo.push(() => deps.applyRelayEveryCall(before.relayEveryCall));
    await deps.applyRelayEveryCall(FIELD_VALUES.relayEveryCall);

    undo.push(() => deps.applySilenceUnknownCallers(before.silenceUnknownCallers));
    await deps.applySilenceUnknownCallers(FIELD_VALUES.silenceUnknownCallers);

    undo.push(() => deps.applyBlankWhileCaptured(before.blankWhileCaptured));
    await deps.applyBlankWhileCaptured(FIELD_VALUES.blankWhileCaptured);

    // Only when App Lock is on: with it off the setting is inert and there is
    // no row to move.
    if (before.lockEnabled) {
      undo.push(() => deps.applyAutolockSec(before.autolockSec));
      await deps.applyAutolockSec(FIELD_VALUES.autolockSec);
    }
  } catch (err) {
    for (const step of undo.reverse()) {
      // Best effort, and silent: the store already refused once, and a
      // rollback failure changes nothing about what the caller must be told.
      try {
        await step();
      } catch {
        // Derived state means a half-restored apply still reads honestly.
      }
    }
    try {
      await deps.deleteSnapshot();
    } catch {
      // A stale snapshot describes the state we just rolled back to, so
      // leaving it is harmless.
    }
    throw err;
  }

  return {
    previewLevel: FIELD_VALUES.previewLevel,
    relayEveryCall: FIELD_VALUES.relayEveryCall,
    silenceUnknownCallers: FIELD_VALUES.silenceUnknownCallers,
    blankWhileCaptured: FIELD_VALUES.blankWhileCaptured,
    lockEnabled: before.lockEnabled,
    autolockSec: before.lockEnabled ? FIELD_VALUES.autolockSec : before.autolockSec,
  };
}

/**
 * Put back the settings that were in force when Field Mode was turned on.
 *
 * A missing or unparseable snapshot restores the SHIPPED DEFAULTS and leaves
 * auto-lock alone — the honest fallback when the record of what was there is
 * gone. The snapshot key is deleted last, so a setter that refuses leaves the
 * record intact and Off can be tried again.
 */
export async function clearFieldMode(
  deps: FieldModeDeps = defaultFieldModeDeps,
): Promise<FieldModeState> {
  const current = await deps.readState();
  let raw: string | null = null;
  try {
    raw = await deps.readSnapshot();
  } catch {
    raw = null;
  }
  const snapshot = decodeSnapshot(raw);
  // The auto-lock write is gated on App Lock being ON NOW as well as on the
  // snapshot having recorded a value — so the returned state must be gated
  // the same way. Reporting a value that was not written is how the caller's
  // `applyRows(settled)` inherits a stale number and hands it back to
  // `lock.setAutolock` the next time App Lock is enabled.
  const restoresAutolock =
    current.lockEnabled && snapshot !== null && snapshot.autolockSec !== null;

  const target: FieldModeState = {
    previewLevel: snapshot ? snapshot.previewLevel : SHIPPED_DEFAULTS.previewLevel,
    relayEveryCall: snapshot
      ? snapshot.relayEveryCall
      : SHIPPED_DEFAULTS.relayEveryCall,
    silenceUnknownCallers: snapshot
      ? snapshot.silenceUnknownCallers
      : SHIPPED_DEFAULTS.silenceUnknownCallers,
    blankWhileCaptured: snapshot
      ? snapshot.blankWhileCaptured
      : SHIPPED_DEFAULTS.blankWhileCaptured,
    lockEnabled: current.lockEnabled,
    autolockSec:
      restoresAutolock && snapshot?.autolockSec != null
        ? snapshot.autolockSec
        : current.autolockSec,
  };

  await deps.applyPreviewLevel(target.previewLevel);
  await deps.applyRelayEveryCall(target.relayEveryCall);
  await deps.applySilenceUnknownCallers(target.silenceUnknownCallers);
  await deps.applyBlankWhileCaptured(target.blankWhileCaptured);
  // Auto-lock moves only when the snapshot actually recorded one: an apply
  // made with App Lock off wrote `null`, and there is nothing to put back.
  if (restoresAutolock && snapshot?.autolockSec != null) {
    await deps.applyAutolockSec(snapshot.autolockSec);
  }

  await deps.deleteSnapshot();
  return target;
}

// --- the duress shadow -------------------------------------------------------

/**
 * What a DURESS session's four mapped rows show.
 *
 * `null` — the coercer has not moved them this session — and the screen
 * renders the decoy's own values, which App.tsx has already reset to their
 * defaults on the way in (`resetPreviewLevelForDuress` and its four
 * siblings). The derived chip therefore reads Off on entry, exactly as it did
 * before, and for a better reason: because the rows say so.
 *
 * Never persisted and never derived from the owner's real settings. This is
 * the ONLY thing a coerced Field Mode tap writes, and it lives for the
 * session.
 */
let duressRows: FieldModeRows | null = null;

/**
 * The in-memory twin of the snapshot: what the four rows held before a
 * coerced On, so a coerced Off puts back the same values a real Off would,
 * and lands on the shipped defaults when there is nothing recorded — the same
 * fallback, and the same sentence in the copy deck covers both.
 */
let duressBefore: FieldModeState | null = null;

/**
 * The mode this shadow was last synchronised with. `session.setMode` clears
 * `lockUi` but knows nothing about this module, and the App.tsx duress block
 * that would call `resetFieldModeForDuress()` is outside this cluster's
 * paths — so the shadow resets itself lazily, on the first read after a mode
 * change, and is correct with or without that line.
 */
let shadowMode: SessionMode = 'real';

function syncShadow(): void {
  if (session.mode !== shadowMode) {
    shadowMode = session.mode;
    duressRows = null;
    duressBefore = null;
  }
}

/**
 * The coerced session's four rows, for a screen that must seed its own copy
 * at mount. `null` in a real session and before the first coerced change.
 */
export function fieldModeDuressRows(): FieldModeRows | null {
  syncShadow();
  return duressRows;
}

/**
 * Keep the coerced session's copy current.
 *
 * Called by the screen whenever ANY of the four rows moves, not only the
 * Field Mode row: in duress those rows are React state, and without this a
 * hand-changed row would snap back to the Field Mode tap's values on the next
 * Settings mount — the chip would then read On over rows the coercer had just
 * changed, which is the same lie in the other direction. A no-op in a real
 * session, where the four stores are the memory.
 */
export function recordFieldModeDuressRows(rows: FieldModeRows): void {
  syncShadow();
  if (session.mode !== 'duress') return;
  duressRows = { ...rows };
}

/**
 * The one setter the UI calls, in both modes.
 *
 * Returns the state the five rows must now show, so the caller has exactly
 * one thing to do with the answer and there is one code path on the screen.
 *
 * In a duress session it touches no store at all — no read, no setter, no
 * snapshot, no Keychain or App-Group byte — and computes the same five values
 * a real tap would land on, from `current` and the in-memory shadow. `current`
 * is what the screen is showing; the real path ignores it and reads the
 * stores for itself.
 */
export async function setFieldMode(
  on: boolean,
  current: FieldModeState,
  deps: FieldModeDeps = defaultFieldModeDeps,
): Promise<FieldModeState> {
  syncShadow();
  if (session.mode === 'duress') return applyDuress(on, current);
  return on ? applyFieldMode(deps) : clearFieldMode(deps);
}

/** A coerced tap, entirely in memory. Mirrors applyFieldMode/clearFieldMode
 * value for value, including the auto-lock gating and the shipped-defaults
 * fallback, so the decoy's screen is indistinguishable from the owner's. */
function applyDuress(on: boolean, current: FieldModeState): FieldModeState {
  const back = duressBefore;
  const rows: FieldModeRows = on
    ? {
        previewLevel: FIELD_VALUES.previewLevel,
        relayEveryCall: FIELD_VALUES.relayEveryCall,
        silenceUnknownCallers: FIELD_VALUES.silenceUnknownCallers,
        blankWhileCaptured: FIELD_VALUES.blankWhileCaptured,
      }
    : back
      ? rowsOf(back)
      : { ...SHIPPED_DEFAULTS };
  // `back.lockEnabled` is the in-memory reading of the snapshot's `null`
  // auto-lock: an On taken with App Lock off recorded nothing to put back.
  const autolockSec = on
    ? current.lockEnabled
      ? FIELD_VALUES.autolockSec
      : current.autolockSec
    : current.lockEnabled && back !== null && back.lockEnabled
      ? back.autolockSec
      : current.autolockSec;

  duressBefore = on ? { ...current } : null;
  duressRows = { ...rows };
  return { ...rows, lockEnabled: current.lockEnabled, autolockSec };
}

/**
 * Entering a duress session shows the DEFAULT, never a previous coercer's
 * taps — the `resetMessageSoundForDuress` shape, for callers that want the
 * canonical hook rather than the lazy reset above.
 */
export function resetFieldModeForDuress(): void {
  duressRows = null;
  duressBefore = null;
  shadowMode = session.mode;
}

/** Test seam: back to what a launched process holds. */
export function resetFieldModeForTests(): void {
  duressRows = null;
  duressBefore = null;
  shadowMode = session.mode;
}
