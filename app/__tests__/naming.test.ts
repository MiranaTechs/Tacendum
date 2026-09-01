/**
 * The naming moment's module half (naming.ts).
 *
 * Four facts, each pinned against the REAL db module over the recording
 * sqlite fake (the profile kv rows are answered from a small in-memory map so
 * loadProfile round-trips):
 *
 *  1. "Not now" leaves `profileVersion 0` and the ULID fallback intact — a
 *     skipped step must not mint a card every peer would then be sent.
 *  2. A name goes through the EXISTING `messaging.saveProfile` and bumps the
 *     version; the fan-out is the lazy chatsMissingMyProfile machinery and
 *     nothing new. The typed name is sanitized at input (the standing regime for
 *     this device's own labels).
 *  3. The nudge is due for a nameless, unsettled account only, and never
 *     again after name-or-skip.
 *  4. A duress-session edit touches the decoy sqlite only.
 *
 * Plus the network assertion: the step performs no
 * REST call and sends no frame — every api function here REJECTS, so a call
 * that got through would fail loudly rather than pass against a stub.
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

jest.mock('../src/api', () => ({
  apiAuthChallenge: jest.fn().mockRejectedValue(new Error('network in test')),
  apiAuth: jest.fn().mockRejectedValue(new Error('network in test')),
  apiUploadKeys: jest.fn().mockRejectedValue(new Error('network in test')),
  apiGetPrekeyBundle: jest.fn().mockRejectedValue(new Error('network in test')),
  apiDeleteAccount: jest.fn().mockRejectedValue(new Error('network in test')),
  apiCreateAttachment: jest
    .fn()
    .mockRejectedValue(new Error('network in test')),
  apiGetAttachmentUrl: jest
    .fn()
    .mockRejectedValue(new Error('network in test')),
  uploadBlob: jest.fn().mockRejectedValue(new Error('network in test')),
  downloadBlob: jest.fn().mockRejectedValue(new Error('network in test')),
}));

import * as db from '../src/db';
import { messaging } from '../src/messaging';
import {
  NAME_MAX,
  isNamingSettled,
  namingNudgeDue,
  normalizeName,
  skipNaming,
  submitName,
} from '../src/naming';
import { personName, shortId } from '../src/person';
import { session } from '../src/session';

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
const api = jest.requireMock('../src/api') as Record<string, jest.Mock>;
const ws = (
  jest.requireMock('../src/ws') as {
    __ws: { calls: { start: jest.Mock; send: jest.Mock } };
  }
).__ws;

const USER_ID = '01KYDBSSDJSPC9J0E5N2AWMJ5Y';

/** A freshly registered account, as registration.ts mints it: no card yet. */
const FRESH: Record<string, string> = {
  userId: USER_ID,
  registrationId: '7',
  displayName: '',
  about: '',
  avatarB64: '',
  profileVersion: '0',
};

/**
 * Answer the `profile` kv table from a map so the module's own reads see its
 * own writes; everything else falls through to the recording default.
 */
function fakeProfileKv(name: string, seed: Record<string, string>) {
  const kv = new Map(Object.entries(seed));
  const file = sqlite.instances.get(name)!;
  const base = file.execute.getMockImplementation()!;
  file.execute.mockImplementation((sql: unknown, params?: unknown[]) => {
    const s = String(sql);
    const p = (params ?? []) as string[];
    if (s.includes('INSERT OR REPLACE INTO profile')) {
      kv.set(p[0]!, p[1]!);
      return { rows: [] };
    }
    if (s.includes('SELECT key, value FROM profile')) {
      return { rows: [...kv].map(([key, value]) => ({ key, value })) };
    }
    if (s.includes('SELECT value FROM profile WHERE key = ?')) {
      const value = kv.get(p[0]!);
      return { rows: value === undefined ? [] : [{ value }] };
    }
    if (s.includes("DELETE FROM profile WHERE key = 'phone'")) {
      kv.delete('phone');
      return { rows: [] };
    }
    if (s.includes('DELETE FROM profile WHERE key = ?')) {
      kv.delete(p[0]!);
      return { rows: [] };
    }
    return base(sql, params);
  });
  return kv;
}

/** Let saveProfile's un-awaited share pass settle before the db closes. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(async () => {
  messaging.stop();
  await db.close();
  sqlite.reset();
  for (const fn of Object.values(api)) fn.mockClear();
  ws.calls.start.mockClear();
  ws.calls.send.mockClear();
  session.setMode('real');
  db.setWorkspace('real');
});

afterEach(async () => {
  await flush();
  messaging.stop();
  await db.close();
  session.setMode('real');
  db.setWorkspace('real');
  jest.restoreAllMocks();
});

describe('normalizeName: the 40-unit bound cuts on a code-point boundary', () => {
  // The envelope's max(40) counts UTF-16 units; an emoji is two of them. A
  // cut through the pair (paste or IME past the field's maxLength) would
  // save a lone surrogate — U+FFFD on the wire, a replacement glyph on
  // every peer. The unit-counting `slice` did exactly that. The `u` flag is
  // load-bearing: without it the class matches the halves of a VALID pair.
  const LONE = /[\uD800-\uDFFF]/u;
  const EMOJI = String.fromCodePoint(0x1f600);

  test('an emoji straddling the bound is dropped whole, never halved', () => {
    const out = normalizeName('a'.repeat(NAME_MAX - 1) + EMOJI);
    expect(out).toBe('a'.repeat(NAME_MAX - 1));
    expect(out.length).toBeLessThanOrEqual(NAME_MAX);
    expect(LONE.test(out)).toBe(false);
    // A lone surrogate is exactly what encodeURIComponent refuses.
    expect(() => encodeURIComponent(out)).not.toThrow();
  });

  test('an emoji that fits exactly is kept, the bound still honoured in units', () => {
    const out = normalizeName('a'.repeat(NAME_MAX - 2) + EMOJI);
    expect(out).toBe('a'.repeat(NAME_MAX - 2) + EMOJI);
    expect(out.length).toBe(NAME_MAX);
    expect(LONE.test(out)).toBe(false);
  });

  test('a joined emoji sequence past the bound loses tail units without leaving a stray half', () => {
    // Family: four emoji joined by U+200D — sanitize keeps the joiner, and
    // the cut may fall inside the sequence, but never inside a pair.
    const FAMILY = [0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467, 0x200d, 0x1f466]
      .map(c => String.fromCodePoint(c))
      .join('');
    const out = normalizeName('a'.repeat(NAME_MAX - 4) + FAMILY);
    expect(out.length).toBeLessThanOrEqual(NAME_MAX);
    expect(LONE.test(out)).toBe(false);
    expect(() => encodeURIComponent(out)).not.toThrow();
  });

  test('plain names inside the bound are untouched, over it are cut to it', () => {
    expect(normalizeName('Ada Lovelace')).toBe('Ada Lovelace');
    expect(normalizeName('b'.repeat(NAME_MAX + 10))).toBe('b'.repeat(NAME_MAX));
    // A cut that lands on a space still trims — one line, no dangling gap.
    expect(normalizeName('c'.repeat(NAME_MAX - 1) + ' d')).toBe('c'.repeat(NAME_MAX - 1));
  });
});

describe('a real session', () => {
  beforeEach(async () => {
    await db.initDb();
    fakeProfileKv('tacendum.sqlite', FRESH);
  });

  test('Not now leaves profileVersion 0 and the ULID fallback intact, and settles the nudge', async () => {
    const before = (await db.loadProfile())!;
    expect(namingNudgeDue(before, await isNamingSettled())).toBe(true);

    await skipNaming();

    const after = (await db.loadProfile())!;
    expect(after.profileVersion).toBe(0);
    expect(after.displayName).toBe('');
    // Nothing to show but the id tail — exactly what a skipped step means.
    expect(personName(USER_ID, after.displayName, null)).toBe(shortId(USER_ID));
    expect(await isNamingSettled()).toBe(true);
    expect(namingNudgeDue(after, true)).toBe(false);
  });

  test('a name goes through the existing saveProfile, bumps the version, and is sanitized at input', async () => {
    const save = jest.spyOn(messaging, 'saveProfile');
    const profile = (await db.loadProfile())!;

    // A bidi override, a zero-width space, and a run of spaces — none of it
    // is a name; the input regime for this device's own labels applies.
    const saved = await submitName(profile, '\u202E Ada \u200B  Lovelace ');

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({
      displayName: 'Ada Lovelace',
      about: '',
      avatarB64: '',
    });
    expect(saved?.displayName).toBe('Ada Lovelace');
    expect(saved!.profileVersion).toBeGreaterThan(0);
    expect(personName(USER_ID, saved!.displayName, null)).toBe('Ada Lovelace');
    expect(await isNamingSettled()).toBe(true);
    expect(namingNudgeDue(saved!, true)).toBe(false);
  });

  test('a name of nothing but noise saves nothing', async () => {
    const save = jest.spyOn(messaging, 'saveProfile');
    const profile = (await db.loadProfile())!;
    expect(await submitName(profile, ' \u202E \u200B ')).toBeNull();
    expect(save).not.toHaveBeenCalled();
    expect((await db.loadProfile())!.profileVersion).toBe(0);
    expect(await isNamingSettled()).toBe(false);
  });

  test('the nudge is due for a nameless, unsettled account only', () => {
    expect(namingNudgeDue({ displayName: '' }, false)).toBe(true);
    expect(namingNudgeDue({ displayName: '' }, true)).toBe(false);
    expect(namingNudgeDue({ displayName: 'Ada' }, false)).toBe(false);
    expect(namingNudgeDue({ displayName: 'Ada' }, true)).toBe(false);
  });

  test('the step reaches no REST endpoint and sends no frame', async () => {
    const profile = (await db.loadProfile())!;
    await submitName(profile, 'Ada');
    await skipNaming();
    await flush();
    for (const [name, fn] of Object.entries(api)) {
      expect({ [name]: fn.mock.calls.length }).toEqual({ [name]: 0 });
    }
    expect(ws.calls.start).not.toHaveBeenCalled();
    expect(ws.calls.send).not.toHaveBeenCalled();
  });
});

describe('a duress session', () => {
  beforeEach(async () => {
    session.setMode('duress');
    db.setWorkspace('decoy');
    await db.initDb();
  });

  const decoyProfile: db.ProfileRow = {
    userId: USER_ID,
    registrationId: 7,
    displayName: '',
    about: '',
    avatarB64: '',
    profileVersion: 0,
  };

  const profileWrites = (file: FakeDb | undefined) =>
    (file?.execute.mock.calls ?? [])
      .filter(c => String(c[0]).includes('INSERT OR REPLACE INTO profile'))
      .map(c => c[1] as [string, string]);

  test('a name typed under duress lands in the decoy file only — no real file, no frame', async () => {
    await submitName(decoyProfile, 'Ada');
    const writes = profileWrites(sqlite.instances.get('tacendum-decoy.sqlite'));
    expect(writes).toContainEqual(['displayName', 'Ada']);
    expect(writes.some(([key]) => key === 'namingSettled')).toBe(true);
    expect(sqlite.instances.has('tacendum.sqlite')).toBe(false);
    expect(ws.calls.send).not.toHaveBeenCalled();
    for (const fn of Object.values(api)) expect(fn).not.toHaveBeenCalled();
  });

  test('Not now under duress settles the decoy only', async () => {
    await skipNaming();
    const writes = profileWrites(sqlite.instances.get('tacendum-decoy.sqlite'));
    expect(writes.some(([key]) => key === 'namingSettled')).toBe(true);
    expect(sqlite.instances.has('tacendum.sqlite')).toBe(false);
  });
});
