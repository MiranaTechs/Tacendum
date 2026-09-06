/**
 * SETTLED AND DISABLED STOP BEING OPACITY.
 *
 * `primitives.tsx:173` states the rule the whole product keeps: "Disabled is
 * a recessed surface, never opacity." `ApprovalCard.tsx:312-318` removed the
 * exact line this lane still carried, measured the settled status line it
 * produced at ≈2.8:1 — under the 4.5:1 AA floor — and named it "the CallTile
 * rule". CallTile still had `settled: { opacity: 0.66 }`; the picker's full
 * rows and the control bar's disabled buttons had the same thing in the
 * ternary form.
 *
 * State recedes here the way it recedes in ApprovalCard: muted INK on the
 * words, a soft edge on the box, and the status line still saying the word —
 * so the distinction is never colour alone, and dimming never drags a
 * legible pairing under the contrast floor.
 *
 * DELIBERATELY NOT SWEPT: `CallOverlay.tsx:363` and
 * `IncomingCallScreen.tsx:171`. Both are PRESSED feedback, not state — a
 * finger is on the control and the dip lasts as long as the touch. Changing
 * them would be a diff with no defect behind it, so the sweep below covers
 * the five files this item names and says so rather than pretending to be
 * app-wide.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { StyleSheet, Text } from 'react-native';
import { CallTile } from '../src/ui/CallTile';
import { CallPicker } from '../src/ui/CallPicker';
import { ControlButton } from '../src/components/CallControls';
import { themeTokens } from '../src/theme';

const t = themeTokens();
const ANA = '01J0000000000000000000000A';
const BEN = '01J0000000000000000000000B';

const mounted: ReactTestRenderer.ReactTestRenderer[] = [];
afterEach(() => {
  ReactTestRenderer.act(() => {
    for (const tree of mounted.splice(0)) tree.unmount();
  });
});

function render(node: React.JSX.Element) {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(node);
  });
  mounted.push(tree);
  return tree;
}

/** Every style object in a subtree, flattened — function styles resolved for
 * an UNPRESSED control, which is the state the rule is about. */
function styles(tree: ReactTestRenderer.ReactTestRenderer): Record<string, unknown>[] {
  return tree.root
    .findAll(n => typeof n.type === 'string')
    .map(n =>
      typeof n.props.style === 'function'
        ? StyleSheet.flatten(n.props.style({ pressed: false }))
        : StyleSheet.flatten(n.props.style),
    )
    .filter((s): s is Record<string, unknown> => !!s);
}

function textColour(tree: ReactTestRenderer.ReactTestRenderer, body: string): unknown {
  const node = tree.root.findAll(
    n => n.type === Text && [n.props.children].flat().join('') === body,
  )[0]!;
  return StyleSheet.flatten(node.props.style).color;
}

describe('a settled tile recedes without dimming', () => {
  it('carries no opacity at all, live or settled', () => {
    for (const phase of ['connected', 'declined'] as const) {
      const tree = render(
        <CallTile leg={{ peerId: ANA, phase, skipped: null }} name="Ana" />,
      );
      for (const style of styles(tree)) {
        expect(style).not.toHaveProperty('opacity');
      }
    }
  });

  it('recedes in the INK instead, and still says the word', () => {
    const live = render(
      <CallTile leg={{ peerId: ANA, phase: 'connected', skipped: null }} name="Ana" />,
    );
    const settled = render(
      <CallTile leg={{ peerId: ANA, phase: 'declined', skipped: null }} name="Ana" />,
    );
    expect(textColour(live, 'Ana')).toBe(t.color.mediaInk);
    expect(textColour(settled, 'Ana')).toBe(t.color.mediaInkMuted);
    // Never colour alone: the status line is the distinction a person who
    // cannot see the difference reads.
    expect(textColour(settled, 'Declined')).toBe(t.color.mediaInkMuted);
    expect(textColour(live, 'Connected')).toBe(t.color.mediaInkMuted);
  });
});

describe('a full picker row recedes without dimming', () => {
  /** A picker whose cap is already reached: every unpicked row is disabled. */
  function fullPicker() {
    return render(
      <CallPicker
        candidates={[
          { peerId: ANA, name: 'Ana' },
          { peerId: BEN, name: 'Ben' },
        ]}
        cap={1}
        seatsTaken={1}
        maxHeight={400}
        onCancel={jest.fn()}
        onStart={jest.fn()}
      />,
    );
  }

  it('carries no opacity on the row', () => {
    const tree = fullPicker();
    const row = tree.root.findAll(
      n => n.props.testID === `call-picker-row-${ANA}`,
    )[0]!;
    const flat = StyleSheet.flatten(row.props.style({ pressed: false }));
    expect(flat).not.toHaveProperty('opacity');
    // The disabled state is still stated, and still reaches a screen reader.
    expect(row.props.accessibilityState).toEqual({ checked: false, disabled: true });
  });

  it('recedes in the ink and the checkbox edge', () => {
    const tree = fullPicker();
    expect(textColour(tree, 'Ana')).toBe(t.color.inkMuted);
    const row = tree.root.findAll(
      n => n.props.testID === `call-picker-row-${ANA}`,
    )[0]!;
    const box = row.findAll(n => typeof n.type === 'string')[0]!;
    // The box the checkmark lives in: a soft edge, the OutlineButton's own
    // disabled treatment.
    const edges = row
      .findAll(n => typeof n.type === 'string')
      .map(n => StyleSheet.flatten(n.props.style)?.borderColor)
      .filter(Boolean);
    expect(edges).toContain(t.color.lineSoft);
    expect(box).toBeDefined();
  });
});

describe('a disabled control button recedes without dimming', () => {
  function button(disabled: boolean) {
    return render(
      <ControlButton
        label="Flip camera"
        glyph="camera-flip"
        active={false}
        disabled={disabled}
        onPress={jest.fn()}
        theme={t}
      />,
    );
  }

  it('keeps PRESSED feedback and drops the disabled dim', () => {
    const tree = button(true);
    const press = tree.root.findAll(
      n => typeof n.props.style === 'function',
    )[0]!;
    const resting = StyleSheet.flatten(press.props.style({ pressed: false })) as {
      opacity?: number;
    };
    // Nothing dims a disabled button at rest — `opacity: 1` is the absence of
    // a dim, not a dim of 1.
    expect(resting.opacity ?? 1).toBe(1);
    // Pressed is a finger on the control, not a state: it stays.
    expect(StyleSheet.flatten(press.props.style({ pressed: true })).opacity).toBe(0.7);
  });

  it('recedes in the surface and the ink', () => {
    const off = StyleSheet.flatten(
      button(true).root
        .findAll(n => typeof n.props.style === 'function')[0]!
        .props.style({ pressed: false }),
    );
    const on = StyleSheet.flatten(
      button(false).root
        .findAll(n => typeof n.props.style === 'function')[0]!
        .props.style({ pressed: false }),
    );
    expect(on.backgroundColor).toBe(t.color.mediaLine);
    expect(off.backgroundColor).toBe('transparent');
    expect(off.borderColor).toBe(t.color.mediaLine);
  });
});

describe('the sweep', () => {
  it('finds no numeric opacity outside the named pressed-feedback lines', () => {
    const { readFileSync } = require('fs') as {
      readFileSync: (p: string, e: string) => string;
    };
    const { join } = require('path') as { join: (...p: string[]) => string };
    const FILES = [
      'src/screens/CallScreen.tsx',
      'src/screens/GroupCallScreen.tsx',
      'src/ui/CallTile.tsx',
      'src/ui/CallPicker.tsx',
      'src/components/CallControls.tsx',
    ];
    /** The only opacity this lane may keep: a finger on a control. */
    const PRESSED_ONLY = 'opacity: pressed ? 0.7 : 1,';
    const found: string[] = [];
    for (const file of FILES) {
      const source = readFileSync(join(__dirname, '..', file), 'utf8');
      for (const line of source.split('\n')) {
        const trimmed = line.trim();
        // Comments are the record of what was removed and why; the sweep is
        // about CODE.
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
        if (trimmed.includes('opacity:')) found.push(`${file}: ${trimmed}`);
      }
    }
    // FALSIFYING CASE, run at authoring time: before the change this listed
    // three lines — CallTile's `settled: { opacity: 0.66 }`, CallPicker's
    // `opacity: disabled ? 0.45: 1` and CallControls' `disabled ? 0.4:`.
    expect(found).toEqual([`src/components/CallControls.tsx: ${PRESSED_ONLY}`]);
  });
});
