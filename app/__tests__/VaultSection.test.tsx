/**
 * VaultSection in isolation:
 *
 *  - a messaging notification — any of them, for any Room — used
 *    to re-read the whole thread and `parseEnvelope` EVERY outbound row, on
 *    every notification. The section now parses only rows that announce
 *    themselves as vault envelopes, and coalesces a burst into one read.
 *  - a revealed value stayed revealed until the person left the
 *    Room — across backgrounding, so it was on glass the instant the app came
 *    back, and indefinitely. It now re-masks after its reveal window and the
 *    moment the app leaves the foreground.
 *
 * The db and messaging seams are spied rather than driven through the fake
 * op-sqlite (PeerProfile.vault.test.tsx does that): the assertions here are
 * about WHAT the section reads and WHEN, which is a call ledger's job. */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { AppState } from 'react-native';
import * as db from '../src/db';
import * as envelope from '../src/envelope';
import { messaging } from '../src/messaging';
import { VaultSection } from '../src/ui/VaultSection';
import {
  MASKED_VALUE,
  VAULT,
  VAULT_RELOAD_DEBOUNCE_MS,
  VAULT_REVEAL_MS,
} from '../src/vault';

const T0 = 1_756_000_000_000;
const ME_ID = '01AAAAZ3NDEKTSV4RRFFQ69G5F';
const PEER = '01BBBBZ3NDEKTSV4RRFFQ69G5F';
const ITEM = '01WFXZ3NDEKTSV4RRFFQ69G5AB';
/** Distinctive enough that a substring search for it cannot be a false hit. */
const SECRET = 'HUNTER2-MY-DOOR-CODE-9184';

const item: db.VaultItemRow = {
  peerId: PEER,
  id: ITEM,
  writerId: ME_ID,
  seq: 1,
  ackSeq: 0,
  title: 'Wi-Fi',
  body: SECRET,
  updatedAt: T0,
  deleted: 0,
  contested: false,
};

function row(over: Partial<db.MessageRow>): db.MessageRow {
  return {
    msgId: '01WFXZ3NDEKTSV4RRFFQ69G500',
    peerId: PEER,
    direction: 'out',
    body: 'hello',
    ts: T0,
    status: 'sent',
    ...over,
  };
}

let listeners: Array<() => void> = [];
let appStateListeners: Array<(next: string) => void> = [];
let listVaultItems: jest.SpyInstance;
let listMessages: jest.SpyInstance;
let parse: jest.SpyInstance;

beforeEach(() => {
  listeners = [];
  appStateListeners = [];
  listVaultItems = jest.spyOn(db, 'listVaultItems').mockResolvedValue([item]);
  jest.spyOn(db, 'listVaultContenders').mockResolvedValue([]);
  listMessages = jest.spyOn(db, 'listMessages').mockResolvedValue([]);
  parse = jest.spyOn(envelope, 'parseEnvelope');
  jest.spyOn(messaging, 'subscribe').mockImplementation(listener => {
    listeners.push(listener);
    return () => {
      listeners = listeners.filter(l => l !== listener);
    };
  });
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation(((_type: string, fn: (next: string) => void) => {
      appStateListeners.push(fn);
      return { remove: jest.fn() };
    }) as unknown as typeof AppState.addEventListener);
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

async function render(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <VaultSection peerId={PEER} meUserId={ME_ID} who="Sam" blockedAt={null} />,
    );
  });
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

function valueText(tree: ReactTestRenderer.ReactTestRenderer): string {
  return tree.root.findByProps({ testID: `peer-vault-value-${ITEM}` }).props
    .children as string;
}

describe('the undelivered-item read', () => {
  it('parses only the outbound rows that announce a vault envelope', async () => {
    const vaultBody = `{"tcm":"vault","op":"set","id":"${ITEM}"}`;
    listMessages.mockResolvedValue([
      row({ msgId: 'a', body: 'hello' }),
      row({ msgId: 'b', body: '{"tcm":"image","key":"x"}' }),
      row({ msgId: 'c', direction: 'in', body: vaultBody }),
      row({ msgId: 'd', body: ' {"tcm":"vault"' }),
      row({ msgId: 'e', body: vaultBody, status: 'error' }),
    ]);
    await render();
    expect(parse).toHaveBeenCalledTimes(1);
    expect(parse).toHaveBeenCalledWith(vaultBody);
  });

  it('coalesces a burst of messaging notifications into one re-read', async () => {
    jest.useFakeTimers({ now: T0 });
    await render();
    expect(listVaultItems).toHaveBeenCalledTimes(1);

    await ReactTestRenderer.act(async () => {
      for (let i = 0; i < 5; i += 1) for (const listener of listeners) listener();
    });
    // Nothing yet: the burst is still coalescing.
    expect(listVaultItems).toHaveBeenCalledTimes(1);

    await ReactTestRenderer.act(async () => {
      jest.advanceTimersByTime(VAULT_RELOAD_DEBOUNCE_MS);
    });
    expect(listVaultItems).toHaveBeenCalledTimes(2);
  });
});

describe('a revealed value does not stay revealed', () => {
  it('re-masks when its reveal window closes', async () => {
    jest.useFakeTimers({ now: T0 });
    const tree = await render();
    expect(valueText(tree)).toBe(MASKED_VALUE);

    await press(tree, `peer-vault-reveal-${ITEM}`);
    expect(valueText(tree)).toBe(SECRET);

    await ReactTestRenderer.act(async () => {
      jest.advanceTimersByTime(VAULT_REVEAL_MS - 1);
    });
    expect(valueText(tree)).toBe(SECRET);

    await ReactTestRenderer.act(async () => {
      jest.advanceTimersByTime(1);
    });
    expect(valueText(tree)).toBe(MASKED_VALUE);
    expect(JSON.stringify(tree.toJSON())).not.toContain(SECRET);
  });

  it('re-masks the moment the app leaves the foreground', async () => {
    const tree = await render();
    await press(tree, `peer-vault-reveal-${ITEM}`);
    expect(valueText(tree)).toBe(SECRET);

    await ReactTestRenderer.act(async () => {
      for (const listener of appStateListeners) listener('inactive');
    });
    expect(valueText(tree)).toBe(MASKED_VALUE);
    expect(JSON.stringify(tree.toJSON())).not.toContain(SECRET);
  });

  it('hiding by hand cancels the window, and a fresh reveal gets a fresh one', async () => {
    jest.useFakeTimers({ now: T0 });
    const tree = await render();
    await press(tree, `peer-vault-reveal-${ITEM}`);
    await press(tree, `peer-vault-reveal-${ITEM}`);
    expect(valueText(tree)).toBe(MASKED_VALUE);

    await ReactTestRenderer.act(async () => {
      jest.advanceTimersByTime(VAULT_REVEAL_MS / 2);
    });
    await press(tree, `peer-vault-reveal-${ITEM}`);
    await ReactTestRenderer.act(async () => {
      jest.advanceTimersByTime(VAULT_REVEAL_MS - 1);
    });
    expect(valueText(tree)).toBe(SECRET);
  });

  it('the reveal action says how long the value stays on glass', () => {
    expect(VAULT.show).toBe(`Show for ${VAULT_REVEAL_MS / 1000} s`);
  });
});
