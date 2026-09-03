/**
 * "Delete for me" tells the CHAT LIST, not just the thread.
 *
 * THE DEFECT THIS FILE EXISTS FOR. Removing a message went straight to the
 * store — `db.deleteMessage` with the thread's own `refresh` — and the store
 * recomputes the chat's line inside that transaction. That is enough on the
 * PHONE shell, where the list is unmounted behind the thread and re-reads on
 * return. It is not enough on the WIDE shell, where the list is LIVE beside
 * the open thread and repaints on `messaging.notify()` alone: the row kept
 * previewing the words the person had just deleted until some unrelated
 * receipt or socket transition fired — or indefinitely, offline.
 *
 * The delete now goes through `messaging.deleteForMe`, which notifies the
 * way every other line-changing path in messaging.ts does. Pinned here at
 * the two seams that matter: the screen reaches the service, and the service
 * pokes the subscription the live list is built on (ui/useCoalescedSubscribe
 * → messaging.subscribe).
 *
 * Harness copied from ChatThread.rail.test.tsx. */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import * as db from '../src/db';
import { messaging } from '../src/messaging';
import { ChatThreadScreen } from '../src/screens/ChatThreadScreen';

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

const T0 = new Date('2026-09-02T12:00:00').getTime();

const TEXT_IN = {
  msgId: '01TEXTIN',
  peerId: 'peer-1',
  direction: 'in',
  body: 'see the garden',
  ts: T0,
  status: 'received',
};

beforeEach(async () => {
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(async (sql: string, params?: unknown) => {
    if (String(sql).includes('FROM messages')) {
      return { rows: [TEXT_IN] };
    }
    return base(sql, params);
  });
});

afterEach(async () => {
  await db.close();
  jest.restoreAllMocks();
});

async function renderThread(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <ChatThreadScreen
        peerId="peer-1"
        onBack={jest.fn()}
        onOpenPeerProfile={jest.fn()}
        onOpenPhoto={jest.fn()}
      />,
    );
  });
  await ReactTestRenderer.act(async () => {});
  return tree;
}

const press = async (
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): Promise<void> => {
  const node = tree.root
    .findAllByProps({ testID })
    .find(n => typeof n.props.onPress === 'function');
  await ReactTestRenderer.act(async () => {
    node!.props.onPress();
  });
};

test('Delete for me pokes the subscription the live chat list is built on', async () => {
  const remove = jest
    .spyOn(db, 'deleteMessage')
    .mockResolvedValue(undefined as never);
  // Exactly what the wide shell's list holds while the thread is open
  // (ui/useCoalescedSubscribe subscribes to nothing else).
  const listHeard = jest.fn();
  const off = messaging.subscribe(listHeard);

  const tree = await renderThread();
  const bubble = tree.root
    .findAllByProps({ testID: 'msg-01TEXTIN' })
    .find(n => n.props.onLongPress);
  await ReactTestRenderer.act(async () => {
    bubble!.props.onLongPress();
  });

  // Nothing has changed yet: the count below must be the DELETE's doing and
  // not a notify the render happened to cause.
  await press(tree, 'delete-01TEXTIN');
  const before = listHeard.mock.calls.length;
  await press(tree, 'delete-mine-01TEXTIN');
  await ReactTestRenderer.act(async () => {});

  expect(remove).toHaveBeenCalledWith('01TEXTIN', 'in');
  expect(listHeard.mock.calls.length).toBeGreaterThan(before);

  off();
  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});

test('deleteForMe removes the row and only then notifies', async () => {
  const order: string[] = [];
  const remove = jest
    .spyOn(db, 'deleteMessage')
    .mockImplementation(async () => {
      order.push('deleted');
    });
  const off = messaging.subscribe(() => order.push('notified'));

  await messaging.deleteForMe('01TEXTIN', 'in');

  expect(remove).toHaveBeenCalledWith('01TEXTIN', 'in');
  expect(order).toEqual(['deleted', 'notified']);
  off();
});

test('a delete that FAILS notifies nobody — nothing changed', async () => {
  jest
    .spyOn(db, 'deleteMessage')
    .mockRejectedValue(new Error('database is locked'));
  const listHeard = jest.fn();
  const off = messaging.subscribe(listHeard);

  await expect(messaging.deleteForMe('01TEXTIN', 'in')).rejects.toThrow(
    'database is locked',
  );

  expect(listHeard).not.toHaveBeenCalled();
  off();
});
