/**
 * The approval card's ACTION ROW layout (device demo, build 9) — red-first.
 *
 * On a real phone the card rendered Deny as a crushed pill, the word wrapping
 * character by character beside a full-width Approve. Root cause:
 * PrimaryButton's base style carries `width: '100%'` (full-bleed by design),
 * and inside the actions row that width became Approve's flex BASIS — shrink
 * resolution handed Approve nearly the whole row and compressed Deny below
 * its own label, because Deny declared `flexShrink: 1` with no minimum.
 *
 * There is no layout engine under the test renderer, so the pin is the flex
 * contract that makes the crush impossible at EVERY row width, not a
 * measurement at one:
 *
 *  - Deny never shrinks (`flexShrink: 0`) and owns a minimum wide enough for
 *    its whole label — no row width can push the container below the text,
 *    so "Deny" lays out on one line at any representative width;
 *  - Approve's basis is 0 with the primitive's `width` retired to 'auto' —
 *    prominence comes from GROWING into the space Deny does not need, never
 *    from a 100% basis that starves the neighbour;
 *  - the row itself is the call-actions anatomy (IncomingCallScreen): a row
 *    with a gap, children stretched to one shared height.
 *
 * VoiceOver contract held: both actions keep role=button and their labels.
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { StyleSheet } from 'react-native';
import type { ApprovalRow } from '../src/db';
import { ApprovalCard } from '../src/ui/ApprovalCard';

// Away from New Year's midnight so the captured year is stable in every zone.
const NOW = Date.UTC(1970, 0, 2, 12);

function approval(over: Partial<ApprovalRow> = {}): ApprovalRow {
  return {
    peerId: 'peer-1',
    q: '01J8MEAPPR0VAQ4X2C6TKN9RFV',
    wireMsgId: '01APPROVALWIRE000000000001',
    kind: 'exec',
    payload: 'npm test -- --watch=false',
    payloadBytes: 25,
    ttlSec: 600,
    sessionTag: null,
    verbs: ['approve', 'deny'],
    ts: NOW,
    arrivedAt: NOW,
    state: 'pending',
    answerVerb: null,
    settledAt: null,
    ...over,
  } as ApprovalRow;
}

async function renderCard(
  a: ApprovalRow,
): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <ApprovalCard approval={a} now={NOW} onAnswer={jest.fn()} testID="card" />,
    );
  });
  return tree;
}

/** The HOST node carrying a testID — the element whose style is real. */
function host(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): ReactTestRenderer.ReactTestInstance {
  const found = tree.root.findAll(
    n => typeof n.type === 'string' && n.props.testID === testID,
  );
  expect(found.length).toBeGreaterThan(0);
  return found[0]!;
}

const flat = (style: unknown): Record<string, unknown> =>
  StyleSheet.flatten(style as never) as Record<string, unknown>;

const textOf = (tree: ReactTestRenderer.ReactTestRenderer): string[] =>
  tree.root.findAllByType(require('react-native').Text).map(node =>
    Array.isArray(node.props.children)
      ? node.props.children.join('')
      : String(node.props.children ?? ''),
  );

async function reveal(tree: ReactTestRenderer.ReactTestRenderer, testID: string) {
  const control = tree.root.findAll(n => n.props.testID === testID && typeof n.props.onPress === 'function')[0]!;
  await ReactTestRenderer.act(() => control.props.onPress());
}

describe('the action row (both verbs offered)', () => {
  test('Deny is a real button: never shrinks, owns a one-line minimum, full button height, destructive outline', async () => {
    const tree = await renderCard(approval());
    const deny = host(tree, 'card-deny');
    const s = flat(deny.props.style);

    // THE CRUSH GUARD — width-independent: a non-shrinking child with a
    // label-covering minimum cannot be compressed at any row width, so the
    // word can never wrap character by character again.
    expect(s.flexShrink).toBe(0);
    expect(s.minWidth as number).toBeGreaterThanOrEqual(96);
    // A comfortable tap target at the design system's button height.
    expect(s.minHeight as number).toBeGreaterThanOrEqual(44);
    // Destructive-outline anatomy, never colour alone: bordered, transparent
    // at rest, with horizontal padding so the label breathes.
    expect(s.borderWidth).toBe(1);
    expect(s.backgroundColor).toBe('transparent');
    expect(s.paddingHorizontal as number).toBeGreaterThanOrEqual(12);

    // The whole label, one string, inside the guarded minimum.
    const texts = deny.findAllByType(require('react-native').Text);
    expect(texts.map(t => t.props.children)).toContain('Deny');

    // VoiceOver: still a button, still named.
    expect(deny.props.accessibilityRole).toBe('button');
    expect(deny.props.accessibilityLabel).toBe('Deny');
  });

  test('Approve is prominent by GROWING, never by the primitive’s 100% basis', async () => {
    const tree = await renderCard(approval());
    const s = flat(host(tree, 'card-approve').props.style);

    // The device bug in one line: PrimaryButton's full-bleed width must be
    // retired inside the row, or it becomes the flex basis that starves
    // Deny. Majority width comes from flexGrow over a zero basis.
    expect(s.width).toBe('auto');
    expect(s.flexBasis).toBe(0);
    expect(s.flexGrow as number).toBeGreaterThanOrEqual(1);

    expect(flat(host(tree, 'card-approve').props.style).minHeight as number).toBeGreaterThanOrEqual(
      44,
    );
  });

  test('the row wears the call-actions anatomy: a row with a gap, children stretched to one height', async () => {
    const tree = await renderCard(approval());
    const deny = host(tree, 'card-deny');
    // The nearest host ancestor that lays out a row is the actions row.
    let node: ReactTestRenderer.ReactTestInstance | null = deny.parent;
    let row: Record<string, unknown> | null = null;
    while (node) {
      if (typeof node.type === 'string') {
        const s = flat(node.props.style);
        if (s.flexDirection === 'row') {
          row = s;
          break;
        }
      }
      node = node.parent;
    }
    expect(row).not.toBeNull();
    expect(row!.alignItems).toBe('stretch');
    expect(row!.gap as number).toBeGreaterThanOrEqual(8);
  });
});

describe('the action row (Deny alone)', () => {
  test('a refused payload leaves Deny spanning the row — grown, still never shrunk', async () => {
    const huge = 'x'.repeat(17 * 1024);
    const tree = await renderCard(
      approval({ payload: huge, payloadBytes: huge.length }),
    );
    // Approve is gone (unshown is unapprovable) …
    expect(
      tree.root.findAll(n => n.props.testID === 'card-approve').length,
    ).toBe(0);
    // … and Deny takes the width Approve would have held.
    const s = flat(host(tree, 'card-deny').props.style);
    expect(s.flexGrow as number).toBeGreaterThanOrEqual(1);
    expect(s.flexShrink).toBe(0);
  });
});

describe('source-backed request context and honest settlement copy', () => {
  test.each([
    ['claude', 'Claude'],
    ['codex', 'Codex'],
  ] as const)('renders %s context around, never instead of, the exact payload', async (provider, label) => {
    const tree = await renderCard(
      approval({
        workReceivedAt: NOW,
        work: {
          provider,
          updatedAt: NOW,
          requestId: '01J8MEAPPR0VAQ4X2C6TKN9RFV',
          project: 'Tacendum',
          context: {
            availability: 'captured',
            capturedAt: NOW - 1000,
            repository: 'natln/Tacendum',
            branch: 'feature/chat-review',
            resultSummary: 'The agent reports a change ready for review.',
          },
        },
      }),
    );
    await reveal(tree, 'card-context-toggle');
    await reveal(tree, 'card-details');
    const copy = textOf(tree);
    expect(copy).toEqual(expect.arrayContaining([
      label,
      'Tacendum',
      'natln/Tacendum',
      'feature/chat-review',
      'The agent reports a change ready for review.',
      'npm test -- --watch=false',
    ]));
    expect(copy.join(' ')).toContain('1970');
    expect(copy.join(' ')).toContain('Repository state may have changed since capture.');
    expect(host(tree, 'card-context')).toBeTruthy();
  });

  test('stale and unavailable context are stated rather than filled with guesses', async () => {
    const stale = await renderCard(
      approval({
        work: {
          provider: 'claude',
          updatedAt: NOW,
          requestId: '01J8MEAPPR0VAQ4X2C6TKN9RFV',
          context: {
            availability: 'stale',
            capturedAt: NOW - 5000,
            branch: 'old-branch',
          },
        },
      }),
    );
    await reveal(stale, 'card-context-toggle');
    expect(textOf(stale).join(' ')).toContain('The agent marked this context stale. Captured');

    const unavailable = await renderCard(
      approval({
        work: {
          provider: 'codex',
          updatedAt: NOW,
          requestId: '01J8MEAPPR0VAQ4X2C6TKN9RFV',
          context: { availability: 'unavailable' },
        },
      }),
    );
    await reveal(unavailable, 'card-context-toggle');
    expect(textOf(unavailable)).toContain(
      'The agent could not capture repository or result context for this request.',
    );
  });

  test('context for another q is hidden from this payload', async () => {
    const tree = await renderCard(
      approval({
        work: {
          provider: 'claude',
          updatedAt: NOW,
          requestId: '01J8MEAPPR0VAQ4X2C6TKN9RFW',
          project: 'Wrong request project',
        },
      }),
    );
    expect(textOf(tree)).not.toContain('Wrong request project');
    expect(tree.root.findAll(n => n.props.testID === 'card-source')).toEqual([]);
  });

  test('a local answer says queued and waits for host evidence', async () => {
    const tree = await renderCard(
      approval({ state: 'answered', answerVerb: 'approve', settledAt: NOW }),
    );
    const copy = textOf(tree).join(' ');
    expect(copy).toContain('Approve answer queued');
    expect(copy).toContain('Waiting for an update from the agent.');
    expect(copy).not.toContain('operation ran successfully');
  });

  test('an exact host observation ends local actions without claiming execution', async () => {
    const tree = await renderCard(
      approval({
        hostObservation: 'decision-returned',
        hostObservationProvider: 'codex',
        hostObservationSourceAt: NOW,
        hostObservationReceivedAt: NOW,
      }),
    );
    await reveal(tree, 'card-info');
    const copy = textOf(tree);
    expect(copy).toContain('The agent reports returning the decision to Codex.');
    expect(copy).toContain('This does not confirm that the command or file change ran.');
    expect(copy).toContain('Host updated');
    expect(copy.join(' ')).not.toContain('left');
    expect(tree.root.findAll(n => n.props.testID === 'card-countdown')).toEqual([]);
    expect(tree.root.findAll(n => n.props.testID === 'card-approve')).toEqual([]);
    expect(tree.root.findAll(n => n.props.testID === 'card-deny')).toEqual([]);
  });
});
