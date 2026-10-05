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
 * DELIBERATELY NOT SWEPT: `CallOverlay.tsx` and `IncomingCallScreen.tsx`.
 * Both had only PRESSED feedback here, not state, so the sweep below covers
 * the five files this item names and says so rather than pretending to be
 * app-wide. (Since the white palette both draw a press on their forest and
 * red discs with `PressShade`, never opacity: on the white app ground a dip
 * let the page through and tinted the disc. See the last describe.)
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { StyleSheet, Text, View } from 'react-native';
import { CallTile } from '../src/ui/CallTile';
import { CallPicker } from '../src/ui/CallPicker';
import { ControlButton, PRESS_SHADE } from '../src/components/CallControls';
import { ThemeProvider, themeTokens } from '../src/theme';

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
    // RE-CUT (the white palette, 2026-10-04): a tile lives on the group
    // call, which is audio and so an app screen — charcoal type on the app's
    // ground, where it used to be white type on media black.
    expect(textColour(live, 'Ana')).toBe(t.color.inkStrong);
    expect(textColour(settled, 'Ana')).toBe(t.color.inkMuted);
    // Never colour alone: the status line is the distinction a person who
    // cannot see the difference reads.
    expect(textColour(settled, 'Declined')).toBe(t.color.inkMuted);
    expect(textColour(live, 'Connected')).toBe(t.color.inkMuted);
  });
});

describe('a tile is a card on the app’s ground, the face the app draws everywhere', () => {
  /** The tile's no-photo face: the 64pt disc. */
  function face(tree: ReactTestRenderer.ReactTestRenderer): Record<string, unknown> {
    const discs = styles(tree).filter(s => s.width === 64 && s.height === 64);
    expect(discs).toHaveLength(1);
    return discs[0]!;
  }

  it('is a white card with a hairline edge, and its no-photo face the forest disc with white letters', () => {
    const tree = render(
      <CallTile leg={{ peerId: ANA, phase: 'connected', skipped: null }} name="Ana" />,
    );
    const all = styles(tree);
    // The card: the sheet with the soft hairline, never the media black.
    expect(all).toContainEqual(
      expect.objectContaining({
        backgroundColor: t.color.paperSheet,
        borderColor: t.color.lineSoft,
        borderWidth: 1,
      }),
    );
    expect(all.map(s => s.backgroundColor)).not.toContain(t.color.mediaBlack);
    // RE-CUT (2026-10-05, superseding the earlier white disc in a gray
    // ring): the face is `Avatar`'s own no-photo face, solid forest with
    // white letters, and any edge it draws is the fill itself.
    const disc = face(tree);
    expect(disc.backgroundColor).toBe('#0E6B45');
    expect(disc.borderWidth ? disc.borderColor : '#0E6B45').toBe('#0E6B45');
    expect(disc.borderColor).not.toBe(t.color.lineStrong);
    expect(textColour(tree, 'AN')).toBe('#FFFFFF');
  });

  it('wears the same forest face in dark, and letters an unnamed person "?" on it', () => {
    // The dark palette lifts pine for text and turns onPine charcoal; the
    // face stays the one forest with white letters in both appearances.
    const d = themeTokens('dark');
    for (const name of ['Ana', null]) {
      const tree = render(
        <ThemeProvider mode="dark">
          <CallTile leg={{ peerId: ANA, phase: 'ringing', skipped: null }} name={name} />
        </ThemeProvider>,
      );
      const disc = face(tree);
      expect(disc.backgroundColor).toBe('#0E6B45');
      expect(disc.backgroundColor).not.toBe(d.color.pine);
      expect(disc.borderWidth ? disc.borderColor : '#0E6B45').toBe('#0E6B45');
      expect(textColour(tree, name === null ? '?' : 'AN')).toBe('#FFFFFF');
    }
  });

  it('keeps the letters geometry: frozen at Dynamic Type inside the fixed disc', () => {
    const tree = render(
      <CallTile leg={{ peerId: ANA, phase: 'connected', skipped: null }} name="Ana" />,
    );
    const letters = tree.root.findAll(
      n => n.type === Text && [n.props.children].flat().join('') === 'AN',
    )[0]!;
    expect(letters.props.allowFontScaling).toBe(false);
  });
});

describe('a control on a voice call is drawn on the app ground', () => {
  /** A ControlButton as a voice call draws it. */
  function voice(props: Partial<React.ComponentProps<typeof ControlButton>>) {
    const tree = render(
      <ControlButton
        label="Mute"
        glyph="mic"
        active={false}
        onPress={jest.fn()}
        theme={t}
        onMedia={false}
        {...props}
      />,
    );
    const press = tree.root.findAll(n => typeof n.props.style === 'function')[0]!;
    const resting = StyleSheet.flatten(press.props.style({ pressed: false })) as {
      backgroundColor?: string;
      borderWidth?: number;
      borderColor?: string;
    };
    // The drawn icon's colour: the one `color` prop handed to the glyph.
    const glyph = tree.root.findAll(
      n => typeof n.type !== 'string' && typeof n.props.color === 'string',
    )[0]!.props.color as string;
    return { resting, glyph };
  }

  it('draws the white disc inside a 1pt lineStrong ring, with a charcoal glyph', () => {
    // FALSIFYING CASE: without `onMedia={false}` the same button is the
    // media disc — a translucent white fill with no ring and a white glyph,
    // invisible on a white screen.
    const { resting, glyph } = voice({});
    expect(resting).toMatchObject({
      backgroundColor: t.color.paperSheet,
      borderWidth: 1,
      borderColor: t.color.lineStrong,
    });
    expect(glyph).toBe(t.color.inkStrong);
  });

  it('fills an ON control with charcoal and a white glyph, ring included', () => {
    const { resting, glyph } = voice({ active: true });
    expect(resting).toMatchObject({
      backgroundColor: t.color.inkStrong,
      borderWidth: 1,
      borderColor: t.color.inkStrong,
    });
    expect(glyph).toBe(t.color.paperSheet);
  });

  it('recedes a disabled control to an empty disc in the soft ring, the glyph muted', () => {
    const { resting, glyph } = voice({ disabled: true });
    expect(resting).toMatchObject({
      backgroundColor: 'transparent',
      borderWidth: 1,
      borderColor: t.color.lineSoft,
    });
    expect(glyph).toBe(t.color.inkMuted);
  });

  it('keeps the call actions identical to media: the red end disc, the forest answer, white glyphs', () => {
    for (const onMedia of [true, false]) {
      const end = voice({ label: 'End call', glyph: 'end-call', danger: true, onMedia });
      expect(end.resting.backgroundColor).toBe(t.color.mediaDanger);
      expect(end.glyph).toBe(t.color.mediaInk);
      const answer = voice({ label: 'Answer', glyph: 'phone', active: true, accept: true, onMedia });
      expect(answer.resting.backgroundColor).toBe(t.color.mediaAccent);
      expect(answer.glyph).toBe(t.color.mediaInk);
    }
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
    /** The only opacity these files may keep: a finger on a control — the
     * dip, which now skips the forest and red discs on the app ground, and
     * the shade those discs take instead (a black layer under the glyph). */
    const PRESSED_ONLY = 'opacity: pressed && !shaded ? 0.7 : 1,';
    const SHADE_ONLY = 'opacity: PRESS_SHADE,';
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
    expect(found).toEqual([
      `src/components/CallControls.tsx: ${SHADE_ONLY}`,
      `src/components/CallControls.tsx: ${PRESSED_ONLY}`,
    ]);
  });
});

/** WCAG contrast of two #RRGGBB colours (parseInt, never bitwise). */
function contrast(a: string, b: string): number {
  const luminance = (hex: string): number => {
    const [r, g, bl] = [1, 3, 5].map(i => {
      const v = parseInt(hex.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** `top` at `alpha` over the opaque `under`, as #RRGGBB. */
function composite(top: string, alpha: number, under: string): string {
  const channel = (hex: string, i: number) => parseInt(hex.slice(i, i + 2), 16);
  return `#${[1, 3, 5]
    .map(i =>
      Math.round(channel(top, i) * alpha + channel(under, i) * (1 - alpha))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')
    .toUpperCase()}`;
}

describe('a finger on a forest or red disc darkens it, on every ground', () => {
  /** The pressed state of one control: its style, and the shade its
   * children draw, read off the Pressable's two functions. */
  function pressed(props: Partial<React.ComponentProps<typeof ControlButton>>) {
    const tree = render(
      <ControlButton
        label="End call"
        glyph="end-call"
        active={false}
        onPress={jest.fn()}
        theme={t}
        {...props}
      />,
    );
    const press = tree.root.findAll(n => typeof n.props.style === 'function')[0]!;
    const style = StyleSheet.flatten(press.props.style({ pressed: true })) as {
      opacity?: number;
      backgroundColor?: string;
    };
    const inner = render(<View>{press.props.children({ pressed: true, hovered: false })}</View>);
    const shade = inner.root.findAll(
      n => n.props.testID === 'call-press-shade' && typeof n.type === 'string',
    )[0];
    return { style, shade: shade ? StyleSheet.flatten(shade.props.style) : null };
  }

  it('on the app ground the end and answer discs take the shade, never the dip, and the white glyph stays above 4.5:1', () => {
    for (const props of [
      { danger: true },
      { label: 'Answer', glyph: 'phone', active: true, accept: true },
    ]) {
      const { style, shade } = pressed({ ...props, onMedia: false });
      expect(style.opacity ?? 1).toBe(1);
      expect(shade).toMatchObject({
        position: 'absolute',
        borderRadius: 22,
        backgroundColor: t.color.mediaBlack,
        opacity: PRESS_SHADE,
      });
      const shaded = composite(t.color.mediaBlack, PRESS_SHADE, style.backgroundColor!);
      expect(contrast(t.color.mediaInk, shaded)).toBeGreaterThanOrEqual(4.5);
      // Darker than at rest: the press moves away from the white page.
      expect(contrast(shaded, t.color.paperGround)).toBeGreaterThan(
        contrast(style.backgroundColor!, t.color.paperGround),
      );
      // The dip it replaces, over the white page: mint or pink under the
      // white glyph, below the 4.5:1 a label on the same disc needs.
      expect(
        contrast(t.color.mediaInk, composite(style.backgroundColor!, 0.7, t.color.paperGround)),
      ).toBeLessThan(4.5);
    }
  });

  it('on media the dip stays: there it darkens toward the black ground, and no shade is drawn', () => {
    const { style, shade } = pressed({ danger: true, onMedia: true });
    expect(style.opacity).toBe(0.7);
    expect(shade).toBeNull();
  });
});
