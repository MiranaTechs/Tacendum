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

const NOW = 1_000_000;

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
