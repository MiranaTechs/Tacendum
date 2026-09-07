/**
 * The approval card in the thread — synthetic-row
 * injection from the `approvals` table (the call-chip scheme), rendered by
 * the component contract:
 *
 *  - VERBATIM OR REFUSE: the payload appears byte-exact in its own block, or
 *    the card states why it will not show it — and a card that cannot show
 *    the payload never offers Approve. Nothing is ever truncated.
 *  - THE COUNTDOWN IS A CLOCK READING on a MOVING clock: modern fake timers
 *    advance Date.now() and the interval together — nothing here pins now()
 *    beside an advancing timer (the frozen-clock rule).
 *  - ANSWERS ride the ordinary reply path (`sendReply(peer, wireMsgId, 'in',
 *    verb)`), the card flips only after the send resolves, a double-tap
 *    lands ONE answer, and a tap past the deadline is refused locally —
 *    recorded as a lapse, nothing on the wire.
 *  - Rule 4 stands: no rendered string ever contains the envelope sentinel,
 *    and an approval never becomes a bubble.
 *
 * Harness copied from ChatThread.vault.test.tsx (fake sqlite instance, real
 * db module, real screen).
 */

import React from 'react';
import { FlatList } from 'react-native';
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
    __sqlite: {
      instances: Map<string, FakeDb>;
      reset: () => void;
    };
  }
).__sqlite;

const PEER = 'peer-1';
const Q_PENDING = '01J8MEAPPR0VAQ4X2C6TKN9RFV';
const Q_SECOND = '01J8MEAPPR0VAQ4X2C6TKN9RFW';
const WIRE_MSG = '01APPROVALWIRE000000000001';

/** The exact bytes the machine would run — distinctive, two lines, so a
 * partial match can never pass for the whole. */
const PAYLOAD = 'npm test -- --watch=false\ncwd: /Users/op/tacendum';

type SeedRow = Record<string, string | number | null>;

let seeded: SeedRow[] = [];
let sendReplySpy: jest.SpyInstance;
let scrollToIndexSpy: jest.SpyInstance;

function approvalRow(overrides: Partial<SeedRow> = {}): SeedRow {
  return {
    peerId: PEER,
    q: Q_PENDING,
    wireMsgId: WIRE_MSG,
    kind: 'exec',
    payload: PAYLOAD,
    payloadBytes: 49,
    ttlSec: 600,
    sessionTag: 's-7c2e',
    verbs: '["approve","deny"]',
    ts: Date.now(),
    arrivedAt: Date.now(),
    state: 'pending',
    answerVerb: null,
    settledAt: null,
    ...overrides,
  };
}

beforeEach(async () => {
  jest.useFakeTimers();
  seeded = [];
  sendReplySpy = jest
    .spyOn(messaging, 'sendReply')
    .mockResolvedValue(undefined);
  scrollToIndexSpy = jest
    .spyOn(FlatList.prototype, 'scrollToIndex')
    .mockImplementation(() => {});
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation((sql: string, params?: unknown) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    if (s.startsWith('SELECT') && s.includes('FROM approvals')) {
      return { rows: seeded };
    }
    return base(sql, params);
  });
});

afterEach(async () => {
  sendReplySpy.mockRestore();
  scrollToIndexSpy.mockRestore();
  await db.close();
  jest.useRealTimers();
});

async function renderThread(
  focusedApprovalQ?: string,
): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <ChatThreadScreen
        peerId={PEER}
        onBack={jest.fn()}
        onOpenPeerProfile={jest.fn()}
        onOpenPhoto={jest.fn()}
        focusedApprovalQ={focusedApprovalQ}
      />,
    );
  });
  await ReactTestRenderer.act(async () => {});
  return tree;
}

async function unmount(tree: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
}

/** Every string this screen actually draws. */
function renderedText(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  return tree.root
    .findAllByType(require('react-native').Text)
    .map(n =>
      Array.isArray(n.props.children)
        ? n.props.children.join('')
        : String(n.props.children ?? ''),
    );
}

function pressable(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): ReactTestRenderer.ReactTestInstance | undefined {
  return tree.root.findAll(
    n => n.props.testID === testID && typeof n.props.onPress === 'function',
  )[0];
}

const updatesOf = (fragment: string) =>
  sqlite.instances
    .get('tacendum.sqlite')!
    .execute.mock.calls.filter(c => String(c[0]).includes(fragment));

describe('the pending card', () => {
  test('renders the payload byte-verbatim, the declared buttons, the tag, and a moving countdown', async () => {
    seeded = [approvalRow()];
    const tree = await renderThread();

    await ReactTestRenderer.act(() => {
      pressable(tree, `approval-${Q_PENDING}-details`)!.props.onPress();
    });

    // The card exists and the payload appears EXACTLY — both lines, one
    // node, nothing trimmed, nothing markdown-ed.
    expect(
      tree.root.findAll(n => n.props.testID === `approval-${Q_PENDING}`).length,
    ).toBeGreaterThan(0);
    expect(renderedText(tree)).toContain(PAYLOAD);

    // The fixed header copy and the session tag — never sender prose.
    const texts = renderedText(tree);
    expect(texts).toContain('Approval');
    expect(texts).toContain('Run a command');
    expect(texts).toContain('s-7c2e');
    expect(texts).not.toContain('This room is ready.');
    expect(texts).not.toContain('Write the first message.');

    // Both declared verbs, as buttons.
    expect(pressable(tree, `approval-${Q_PENDING}-approve`)).toBeTruthy();
    expect(pressable(tree, `approval-${Q_PENDING}-deny`)).toBeTruthy();

    // The countdown, and it MOVES: one second of advanced timers advances
    // Date.now() with it (modern fake timers — the moving clock).
    expect(texts).toContain('10:00 left');
    await ReactTestRenderer.act(() => {
      jest.advanceTimersByTime(1000);
    });
    const after = renderedText(tree);
    expect(after).toContain('9:59 left');
    expect(after).not.toContain('10:00 left');

    await unmount(tree);
  });

  test('an unknown verb renders NO button — it can never be sent as an answer', async () => {
    seeded = [approvalRow({ verbs: '["approve","deny","escalate"]' })];
    const tree = await renderThread();
    expect(pressable(tree, `approval-${Q_PENDING}-approve`)).toBeTruthy();
    expect(pressable(tree, `approval-${Q_PENDING}-deny`)).toBeTruthy();
    expect(renderedText(tree).filter(s => s.includes('escalate'))).toEqual([]);
    await unmount(tree);
  });

  test('no rendered string ever contains the envelope sentinel, and the approval is never a bubble', async () => {
    seeded = [approvalRow()];
    const tree = await renderThread();
    expect(renderedText(tree).filter(s => s.includes('"tcm"'))).toEqual([]);
    // The synthetic placeholder row must never reach MessageRow.
    expect(
      tree.root.findAll(
        n =>
          typeof n.props.testID === 'string' &&
          n.props.testID.startsWith('msg-approval:'),
      ),
    ).toEqual([]);
    await unmount(tree);
  });
});

describe('answering', () => {
  test('approve sends the ordinary reply — ref = the wire msgId — then settles; a double-tap lands ONE answer', async () => {
    seeded = [approvalRow()];
    const tree = await renderThread();
    await ReactTestRenderer.act(() => {
      pressable(tree, `approval-${Q_PENDING}-details`)!.props.onPress();
    });
    const approve = pressable(tree, `approval-${Q_PENDING}-approve`)!;

    await ReactTestRenderer.act(async () => {
      // The double-tap: two presses before anything can settle. The
      // synchronous in-flight guard must eat the second.
      approve.props.onPress();
      approve.props.onPress();
    });

    expect(sendReplySpy).toHaveBeenCalledTimes(1);
    expect(sendReplySpy).toHaveBeenCalledWith(PEER, WIRE_MSG, 'in', 'approve');
    // The store settled AFTER the send — the statement carries the answer.
    const settles = updatesOf(`state = 'answered'`);
    expect(settles.length).toBe(1);
    expect(settles[0]![1]).toEqual(
      expect.arrayContaining(['approve', PEER, Q_PENDING]),
    );
    await unmount(tree);
  });

  test('deny sends the deny verb through the same path', async () => {
    seeded = [approvalRow()];
    const tree = await renderThread();
    await ReactTestRenderer.act(async () => {
      pressable(tree, `approval-${Q_PENDING}-deny`)!.props.onPress();
    });
    expect(sendReplySpy).toHaveBeenCalledTimes(1);
    expect(sendReplySpy).toHaveBeenCalledWith(PEER, WIRE_MSG, 'in', 'deny');
    await unmount(tree);
  });

  test('a tap that finds the deadline passed is refused LOCALLY: a lapse is recorded, nothing reaches the wire', async () => {
    // Deadline 400ms out: the card still shows buttons (the 1s tick has not
    // fired), then the clock moves past the deadline UNDER the still-mounted
    // buttons — the exact race the handler's own clock check exists for.
    seeded = [approvalRow({ arrivedAt: Date.now() - 600_000 + 400 })];
    const tree = await renderThread();
    await ReactTestRenderer.act(() => {
      pressable(tree, `approval-${Q_PENDING}-details`)!.props.onPress();
    });
    const approve = pressable(tree, `approval-${Q_PENDING}-approve`)!;

    await ReactTestRenderer.act(() => {
      jest.advanceTimersByTime(500);
    });
    await ReactTestRenderer.act(async () => {
      approve.props.onPress();
    });

    expect(sendReplySpy).not.toHaveBeenCalled();
    expect(updatesOf(`state = 'answered'`)).toEqual([]);
    expect(updatesOf(`state = 'lapsed'`).length).toBeGreaterThan(0);
    await unmount(tree);
  });
});

describe('settled and lapsed states', () => {
  test('a pending row past its deadline renders lapsed — buttons REMOVED, the stated sentence, no contradiction of the CLI', async () => {
    seeded = [approvalRow({ arrivedAt: Date.now() - 700_000 })];
    const tree = await renderThread();
    expect(renderedText(tree)).toContain('Lapsed — nothing was approved.');
    expect(pressable(tree, `approval-${Q_PENDING}-approve`)).toBeUndefined();
    expect(pressable(tree, `approval-${Q_PENDING}-deny`)).toBeUndefined();
    await unmount(tree);
  });

  test('an answered row says the answer was queued and waits for host evidence', async () => {
    seeded = [
      approvalRow({
        state: 'answered',
        answerVerb: 'approve',
        settledAt: Date.now() - 60_000,
      }),
    ];
    const tree = await renderThread();
    const receipt = renderedText(tree).find(s => s.includes('saved here'));
    expect(receipt).toBeTruthy();
    expect(receipt).toContain('Approve answer queued');
    expect(renderedText(tree)).toContain(
      'Waiting for an update from the agent.',
    );
    await ReactTestRenderer.act(() => {
      pressable(tree, `approval-${Q_PENDING}-info`)!.props.onPress();
    });
    expect(renderedText(tree)).toContain('A queued answer is not proof that the operation ran.');
    expect(pressable(tree, `approval-${Q_PENDING}-approve`)).toBeUndefined();
    await unmount(tree);
  });

  test('a redacted settled row says what was cleared and keeps the honest byte count', async () => {
    seeded = [
      approvalRow({
        state: 'answered',
        answerVerb: 'deny',
        settledAt: Date.now() - 60_000,
        payload: '',
      }),
    ];
    const tree = await renderThread();
    expect(renderedText(tree)).toContain('Cleared after settling · 49 bytes');
    await unmount(tree);
  });
});

describe('verbatim or refuse', () => {
  test('an over-cap payload REFUSES with a stated reason — never truncated, and Approve is gone', async () => {
    const huge = 'x'.repeat(16 * 1024 + 1);
    seeded = [approvalRow({ payload: huge, payloadBytes: huge.length })];
    const tree = await renderThread();

    const texts = renderedText(tree);
    expect(texts).toContain(
      'This request is too large to show exactly, so it cannot be approved from here.',
    );
    // NEVER truncated: no fragment of the payload reaches any Text node —
    // not the whole, not a prefix (a truncated command is a different
    // command).
    expect(texts.filter(s => s.includes('xxxxxxxxxx'))).toEqual([]);
    // Approving what cannot be read is refused; denying stays honest.
    expect(pressable(tree, `approval-${Q_PENDING}-approve`)).toBeUndefined();
    expect(pressable(tree, `approval-${Q_PENDING}-deny`)).toBeTruthy();
    await unmount(tree);
  });

  test('a payload the renderer would substitute (lone surrogate) refuses rather than showing altered bytes', async () => {
    seeded = [approvalRow({ payload: 'echo \uD800 oops' })];
    const tree = await renderThread();
    expect(renderedText(tree)).toContain(
      'This request contains text that cannot be shown exactly, so it cannot be approved from here.',
    );
    expect(pressable(tree, `approval-${Q_PENDING}-approve`)).toBeUndefined();
    await unmount(tree);
  });
});

describe('two approvals in one thread', () => {
  test('each card keys and answers by its own q', async () => {
    seeded = [
      approvalRow(),
      approvalRow({ q: Q_SECOND, wireMsgId: '01APPROVALWIRE000000000002', ts: Date.now() + 1 }),
    ];
    const tree = await renderThread();
    expect(
      tree.root.findAll(n => n.props.testID === `approval-${Q_PENDING}`).length,
    ).toBeGreaterThan(0);
    expect(
      tree.root.findAll(n => n.props.testID === `approval-${Q_SECOND}`).length,
    ).toBeGreaterThan(0);
    await ReactTestRenderer.act(async () => {
      pressable(tree, `approval-${Q_SECOND}-deny`)!.props.onPress();
    });
    expect(sendReplySpy).toHaveBeenCalledTimes(1);
    expect(sendReplySpy).toHaveBeenCalledWith(
      PEER,
      '01APPROVALWIRE000000000002',
      'in',
      'deny',
    );
    await unmount(tree);
  });

  test('a routed request id lands on that exact card', async () => {
    seeded = [
      approvalRow(),
      approvalRow({
        q: Q_SECOND,
        wireMsgId: '01APPROVALWIRE000000000002',
        ts: Date.now() + 1,
      }),
    ];

    const tree = await renderThread(Q_SECOND);

    expect(scrollToIndexSpy).toHaveBeenCalledWith({
      index: 1,
      viewPosition: 0.5,
      animated: true,
    });
    await unmount(tree);
  });
});
