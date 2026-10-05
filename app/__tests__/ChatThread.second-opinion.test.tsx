import { type RosterSlot } from '@tacendum/shared/group-fold';
import React from 'react';
import { Text } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import * as db from '../src/db';
import { MENTION_MARK } from '../src/envelope';
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

const ulid = (tag: string) => (tag + '0'.repeat(26)).slice(0, 26);
const ROOM = ulid('R00M2ND');
const OTHER_ROOM = ulid('R00MNEW');
const ME = ulid('ME1');
const CLAUDE = ulid('CLAWDE');
const CODEX = ulid('CDEX');
const SOURCE = `${CLAUDE}.${ulid('ANS')}`;
const T0 = new Date('2026-09-06T18:00:00Z').getTime();

const SLOT_ROWS: RosterSlot[] = [
  { memberId: ME, writerId: ME, seq: 1, state: 'in' },
  {
    memberId: CLAUDE,
    writerId: ME,
    seq: 1,
    state: 'in',
    class: 'integration',
  },
  {
    memberId: CODEX,
    writerId: ME,
    seq: 1,
    state: 'in',
    class: 'integration',
  },
];

const sourceRow: db.MessageRow = {
  msgId: SOURCE,
  peerId: ROOM,
  direction: 'in',
  body: JSON.stringify({
    tcm: 'msg',
    text: 'The storage boundary needs another look.',
    d: 'The deletion and expiry paths share one maintenance transaction.',
    ai: true,
  }),
  ts: T0,
  arrivedAt: T0,
  status: 'received',
  deletedAt: null,
  authorId: CLAUDE,
  ai: 1,
};

function aiState(peerId: string, name: string): db.AiAgentStateRow {
  return {
    peerId,
    provider: peerId === CLAUDE ? 'claude' : 'codex',
    project: 'Tacendum',
    projectReceivedAt: T0,
    capabilities: { notifications: true, approvals: true, tasks: true },
    capabilitiesReceivedAt: T0,
    context: null,
    contextReceivedAt: null,
    usage: null,
    usageReceivedAt: null,
    lastSourceAt: T0,
    lastDisplayAt: T0,
    lastTimeTrusted: true,
    lastReceivedAt: T0,
    displayName: name,
    localName: null,
  };
}

function installRoomDb(
  opts: { machines?: string[]; includeCodex?: boolean } = {},
): void {
  const machines = opts.machines ?? [CLAUDE, CODEX];
  const slots = opts.includeCodex === false ? SLOT_ROWS.slice(0, 2) : SLOT_ROWS;
  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(
    async (sql: string, params?: unknown[]) => {
      const s = String(sql);
      if (s.includes('FROM messages')) return { rows: [sourceRow] };
      if (s.includes('FROM machine_peers')) {
        return { rows: machines.map(peerId => ({ peerId })) };
      }
      if (s.includes('SELECT groupId, ownerId, name FROM groups')) {
        return params?.[0] === ROOM
          ? { rows: [{ groupId: ROOM, ownerId: ME, name: 'Release room' }] }
          : { rows: [] };
      }
      if (s.includes('FROM group_members')) {
        return params?.[0] === ROOM ? { rows: slots } : { rows: [] };
      }
      if (s.includes('FROM chats') && s.includes('ORDER BY')) {
        return {
          rows: [
            { peerId: CLAUDE, displayName: 'Claude', localName: null },
            { peerId: CODEX, displayName: 'Codex', localName: null },
          ],
        };
      }
      if (s.includes('FROM profile')) {
        return {
          rows: [
            { key: 'userId', value: ME },
            { key: 'registrationId', value: '7' },
          ],
        };
      }
      return base(sql, params);
    },
  );
}

async function renderThread(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <ChatThreadScreen
        peerId={ROOM}
        onBack={jest.fn()}
        onOpenPeerProfile={jest.fn()}
        onOpenPhoto={jest.fn()}
      />,
    );
  });
  await ReactTestRenderer.act(async () => {});
  await ReactTestRenderer.act(async () => {});
  return tree;
}

async function press(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): Promise<void> {
  await ReactTestRenderer.act(async () => {
    tree.root.findAll(n => n.props.testID === testID && n.props.onPress)[0]!
      .props.onPress();
  });
}

function has(tree: ReactTestRenderer.ReactTestRenderer, testID: string): boolean {
  return tree.root.findAllByProps({ testID }).length > 0;
}

function renderedText(tree: ReactTestRenderer.ReactTestRenderer): string {
  return tree.root
    .findAllByType(Text)
    .map(n =>
      Array.isArray(n.props.children)
        ? n.props.children
            .map((child: unknown) => (typeof child === 'string' ? child : ''))
            .join('')
        : String(n.props.children ?? ''),
    )
    .join('\n');
}

let states: db.AiAgentStateRow[];
let consent: db.AgentConsentState;

beforeEach(async () => {
  jest.spyOn(Date, 'now').mockReturnValue(T0 + 1_000);
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
  states = [aiState(CLAUDE, 'Claude'), aiState(CODEX, 'Codex')];
  consent = 'consented';
  jest.spyOn(db, 'listAiAgentStates').mockImplementation(async () => states);
  jest.spyOn(db, 'getAgentConsent').mockImplementation(async () => consent);
  jest.spyOn(db, 'getMessage').mockImplementation(async (msgId, direction) =>
    msgId === SOURCE && direction === 'in' ? sourceRow : null,
  );
});

afterEach(async () => {
  jest.restoreAllMocks();
  await db.close();
});

test('prepares a visible editable room mention and waits for the ordinary Send tap', async () => {
  installRoomDb();
  const fanOut = jest
    .spyOn(messaging, 'fanOut')
    .mockResolvedValue({ localMsgId: `${ME}.${ulid('OUT')}`, skipped: [] });
  const tree = await renderThread();

  expect(has(tree, `second-opinion-${SOURCE}`)).toBe(true);
  await press(tree, `second-opinion-${SOURCE}`);
  expect(fanOut).not.toHaveBeenCalled();
  expect(has(tree, 'second-opinion-review')).toBe(true);
  expect(renderedText(tree)).toContain('Group · Release room');
  expect(renderedText(tree)).toContain('Selected agent · Codex');
  expect(renderedText(tree)).toContain(
    'Rounds must be enabled on the selected agent’s computer. This app cannot confirm that setting.',
  );

  const input = tree.root.findByProps({ testID: 'composer-input' });
  expect(input.props.value).toContain('@Codex Please give a second opinion');
  expect(input.props.value).toContain(
    'The deletion and expiry paths share one maintenance transaction.',
  );
  await ReactTestRenderer.act(async () => {
    input.props.onChangeText(`${input.props.value}\nCheck the lock path too.`);
  });
  expect(fanOut).not.toHaveBeenCalled();

  await press(tree, 'composer-send');
  expect(fanOut).toHaveBeenCalledTimes(1);
  const [room, body, options] = fanOut.mock.calls[0]!;
  expect(room).toBe(ROOM);
  expect(JSON.parse(body as string)).toEqual({
    tcm: 'mention',
    text: expect.stringContaining(
      `${MENTION_MARK} Please give a second opinion`,
    ),
    who: [CODEX],
  });
  expect(body).not.toContain('Codex');
  expect(options).toEqual({ preview: expect.stringContaining('@Codex') });
});

test('offers nothing in a one-agent room', async () => {
  installRoomDb({ machines: [CLAUDE], includeCodex: false });
  states = [aiState(CLAUDE, 'Claude')];
  const tree = await renderThread();
  expect(has(tree, `second-opinion-${SOURCE}`)).toBe(false);
});

test('another member’s agent is unavailable until this account consents', async () => {
  installRoomDb({ machines: [CLAUDE] });
  consent = 'undecided';
  const tree = await renderThread();
  expect(has(tree, `second-opinion-${SOURCE}`)).toBe(false);
});

test('confirmation revalidates consent and leaves the reviewed draft unsent when it changed', async () => {
  installRoomDb({ machines: [CLAUDE] });
  const fanOut = jest
    .spyOn(messaging, 'fanOut')
    .mockResolvedValue({ localMsgId: `${ME}.${ulid('OUT')}`, skipped: [] });
  const tree = await renderThread();
  await press(tree, `second-opinion-${SOURCE}`);

  consent = 'refused';
  await press(tree, 'composer-send');
  expect(fanOut).not.toHaveBeenCalled();
  expect(tree.root.findByProps({ testID: 'composer-input' }).props.value).toContain(
    '@Codex Please give a second opinion',
  );
  expect(renderedText(tree)).toContain(
    'The selected agent is no longer available for this room. Review the room’s agent access before sending.',
  );
});

test('cancel removes the prepared request without sending it', async () => {
  installRoomDb();
  const fanOut = jest.spyOn(messaging, 'fanOut');
  const tree = await renderThread();
  await press(tree, `second-opinion-${SOURCE}`);
  await press(tree, 'second-opinion-cancel');
  expect(tree.root.findByProps({ testID: 'composer-input' }).props.value).toBe('');
  expect(has(tree, 'second-opinion-review')).toBe(false);
  expect(fanOut).not.toHaveBeenCalled();
});

test('a peer switch during confirmation cannot send or mutate the new room', async () => {
  installRoomDb();
  const fanOut = jest
    .spyOn(messaging, 'fanOut')
    .mockResolvedValue({ localMsgId: `${ME}.${ulid('OUT')}`, skipped: [] });
  const tree = await renderThread();
  await press(tree, `second-opinion-${SOURCE}`);

  let release!: (value: db.AiAgentStateRow[]) => void;
  jest.spyOn(db, 'listAiAgentStates').mockImplementationOnce(
    () => new Promise(resolve => (release = resolve)),
  );
  let send!: Promise<void>;
  await ReactTestRenderer.act(() => {
    send = tree.root.findByProps({ testID: 'composer-send' }).props.onPress();
  });
  await ReactTestRenderer.act(async () => {
    tree.update(
      <ChatThreadScreen
        peerId={OTHER_ROOM}
        onBack={jest.fn()}
        onOpenPeerProfile={jest.fn()}
        onOpenPhoto={jest.fn()}
      />,
    );
  });
  await ReactTestRenderer.act(async () => {
    release(states);
    await send;
  });
  expect(fanOut).not.toHaveBeenCalled();
  expect(renderedText(tree)).not.toContain('no longer available for this room');
});
