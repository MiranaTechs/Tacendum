/**
 * The naming moment, the screen half.
 *
 * "What should people call you?" is a SKIPPABLE step after a successful
 * registration. Three things are pinned:
 *
 *  - the copy, verbatim (the teaching sentence sits behind the ⓘ, and it is
 *    the one sentence that has to stay true after usernames ship —
 *    the display name and the username are separate things);
 *  - the two exits: Continue saves through the existing `messaging.saveProfile`
 *    with about/avatar untouched, Not now settles the nudge and saves
 *    nothing;
 *  - the network assertion: registration plus the
 *    naming step performs no REST call beyond today's registration — the api
 *    spy is untouched by the step.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

jest.mock('../src/ws', () => {
  const calls = {
    start: jest.fn(),
    stop: jest.fn(),
    send: jest.fn((_frame: unknown) => true),
  };
  class WsClient {
    onFrame() {}
    onState() {}
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
  return { WsClient, __ws: { calls } };
});

jest.mock('../src/api', () => ({
  apiAuthChallenge: jest.fn(),
  apiAuth: jest.fn(),
  apiUploadKeys: jest.fn(),
  apiGetPrekeyBundle: jest.fn(),
  apiDeleteAccount: jest.fn(),
  apiCreateAttachment: jest.fn(),
  apiGetAttachmentUrl: jest.fn(),
  uploadBlob: jest.fn(),
  downloadBlob: jest.fn(),
}));

jest.mock('../src/lock', () => ({ clearAll: jest.fn() }));

import * as db from '../src/db';
import { messaging } from '../src/messaging';
import { NAMING_COPY } from '../src/namingCopy';
import { createOrRestoreAccount } from '../src/registration';
import { NamingScreen } from '../src/screens/NamingScreen';
import { session } from '../src/session';

interface FakeDb {
  name: string;
  execute: jest.Mock;
  close: jest.Mock;
}
const sqlite = (
  jest.requireMock('@op-engineering/op-sqlite') as {
    __sqlite: { instances: Map<string, FakeDb>; reset: () => void };
  }
).__sqlite;
const api = jest.requireMock('../src/api') as Record<string, jest.Mock>;
const ws = (
  jest.requireMock('../src/ws') as {
    __ws: { calls: { start: jest.Mock; send: jest.Mock } };
  }
).__ws;
const crypto = jest.requireMock('tacendum-crypto') as Record<
  string,
  jest.Mock
> & {
  __keychain: Map<string, string>;
};

const USER_ID = '01KYDBSSDJSPC9J0E5N2AWMJ5Y';
const KEYS = {
  identityKey: 'QklHLUlERU5USVRZLUtFWQ==',
  registrationId: 7,
  signedPrekey: { keyId: 1, pub: 'U1BL', sig: 'U0lH' },
  kyberPrekey: { keyId: 1, pub: 'S1lC', sig: 'S1NJRw==' },
  oneTimePrekeys: [{ keyId: 3, pub: 'T1RQ' }],
};
const FRESH: db.ProfileRow = {
  userId: USER_ID,
  registrationId: 7,
  displayName: '',
  about: '',
  avatarB64: '',
  profileVersion: 0,
};

/** The `profile` kv table answered from a map, so reads see writes. */
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
    if (s.startsWith('DELETE FROM profile')) {
      kv.clear();
      return { rows: [] };
    }
    return base(sql, params);
  });
  return kv;
}

let tree: ReactTestRenderer.ReactTestRenderer;
let onDone: jest.Mock;

async function render(profile: db.ProfileRow = FRESH) {
  onDone = jest.fn();
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <NamingScreen profile={profile} onDone={onDone} />,
    );
  });
}

const maybe = (id: string) => tree.root.findAllByProps({ testID: id });
const propOf = (id: string, prop: string) => {
  const node = maybe(id).find(n => n.props[prop] !== undefined);
  if (!node) throw new Error(`no node with testID ${id} carries ${prop}`);
  return node.props[prop];
};
const stateOf = (id: string) =>
  propOf(id, 'accessibilityState') as { disabled?: boolean; busy?: boolean };

async function press(id: string) {
  await ReactTestRenderer.act(async () => {
    propOf(id, 'onPress')();
  });
}
async function type(id: string, text: string) {
  await ReactTestRenderer.act(async () => {
    propOf(id, 'onChangeText')(text);
  });
}
function visibleText(): string {
  return JSON.stringify(tree.toJSON());
}
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(async () => {
  messaging.stop();
  await db.close();
  sqlite.reset();
  crypto.__keychain.clear();
  for (const fn of Object.values(api)) fn.mockReset();
  ws.calls.start.mockClear();
  ws.calls.send.mockClear();
  session.setMode('real');
  db.setWorkspace('real');
  await db.initDb();
});

afterEach(async () => {
  await ReactTestRenderer.act(async () => {
    tree?.unmount();
  });
  await flush();
  messaging.stop();
  await db.close();
  jest.restoreAllMocks();
});

describe('what the step says', () => {
  beforeEach(() => {
    fakeProfileKv('tacendum.sqlite', {
      userId: USER_ID,
      registrationId: '7',
    });
  });

  it('asks the question, and keeps the teaching sentence behind the ⓘ — verbatim', async () => {
    await render();
    expect(visibleText()).toContain('What should people call you?');
    expect(visibleText()).toContain(NAMING_COPY.skip);
    const teaching =
      'This name is stored on your iPhone and shared, end-to-end encrypted, only with people you chat with. Our server never sees it. It is not unique and nobody can search for it.';
    expect(NAMING_COPY.infoLines).toEqual([teaching]);
    expect(visibleText()).not.toContain(teaching);
    await press('naming-info');
    expect(visibleText()).toContain(teaching);
  });

  it('the copy deck never says the word the display layer must not say', () => {
    expect(JSON.stringify(NAMING_COPY).toLowerCase()).not.toContain('username');
  });

  it('Continue is armed only by a name — noise alone does not arm it', async () => {
    await render();
    expect(stateOf('naming-continue').disabled).toBe(true);
    await type('naming-input', ' \u202E ');
    expect(stateOf('naming-continue').disabled).toBe(true);
    await type('naming-input', 'Ada');
    expect(stateOf('naming-continue').disabled).toBe(false);
  });
});

describe('the two exits', () => {
  beforeEach(() => {
    fakeProfileKv('tacendum.sqlite', {
      userId: USER_ID,
      registrationId: '7',
    });
  });

  it('Not now saves nothing, settles the nudge, and hands back null', async () => {
    const save = jest.spyOn(messaging, 'saveProfile');
    await render();
    await press('naming-skip');
    expect(onDone).toHaveBeenCalledWith(null);
    expect(save).not.toHaveBeenCalled();
    expect((await db.loadProfile())!.profileVersion).toBe(0);
    expect(await db.getNamingSettled()).toBe(true);
  });

  it('Continue saves through the existing saveProfile, about and avatar untouched, and hands back the row', async () => {
    const save = jest.spyOn(messaging, 'saveProfile');
    await render();
    await type('naming-input', '  Ada  ');
    await press('naming-continue');
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({
      displayName: 'Ada',
      about: '',
      avatarB64: '',
    });
    expect(onDone).toHaveBeenCalledTimes(1);
    const saved = onDone.mock.calls[0]![0] as db.ProfileRow;
    expect(saved.displayName).toBe('Ada');
    expect(saved.profileVersion).toBeGreaterThan(0);
    expect(await db.getNamingSettled()).toBe(true);
  });

  it('a failed local write says so and stays — nothing is handed back', async () => {
    jest
      .spyOn(messaging, 'saveProfile')
      .mockRejectedValueOnce(new Error('disk full'));
    await render();
    await type('naming-input', 'Ada');
    await press('naming-continue');
    expect(onDone).not.toHaveBeenCalled();
    expect(visibleText()).toContain(NAMING_COPY.saveFailed);
    expect(await db.getNamingSettled()).toBe(false);
  });
});

describe('registration plus the naming step, on the wire', () => {
  it("performs no REST call beyond today's registration — the api spy is untouched by the step", async () => {
    // TODAY'S registration, through the real createOrRestoreAccount: the
    // challenge, the auth, the key upload — three calls, and the profile it
    // mints is nameless at version 0.
    fakeProfileKv('tacendum.sqlite', {});
    crypto.hasIdentity.mockResolvedValue(false);
    crypto.generateAndStoreKeys.mockResolvedValue(KEYS);
    api.apiAuthChallenge!.mockResolvedValue({
      challenge: 'Q0g=',
      expiresAt: 0,
    });
    api.apiAuth!.mockResolvedValue({ userId: USER_ID, authToken: 'tok' });
    api.apiUploadKeys!.mockResolvedValue(undefined);

    const profile = await createOrRestoreAccount();
    expect(profile.displayName).toBe('');
    expect(profile.profileVersion).toBe(0);
    const afterRegistration = Object.fromEntries(
      Object.entries(api).map(([name, fn]) => [name, fn.mock.calls.length]),
    );
    expect(afterRegistration).toEqual({
      ...Object.fromEntries(Object.keys(api).map(name => [name, 0])),
      apiAuthChallenge: 1,
      apiAuth: 1,
      apiUploadKeys: 1,
    });

    // THE STEP: a name, then (on a second mount) Not now.
    await render(profile);
    await type('naming-input', 'Ada');
    await press('naming-continue');
    expect(onDone).toHaveBeenCalledTimes(1);
    await ReactTestRenderer.act(async () => {
      tree.unmount();
    });
    await render((await db.loadProfile())!);
    await press('naming-skip');
    await flush();

    const afterStep = Object.fromEntries(
      Object.entries(api).map(([name, fn]) => [name, fn.mock.calls.length]),
    );
    expect(afterStep).toEqual(afterRegistration);
    expect(ws.calls.send).not.toHaveBeenCalled();
  });
});
