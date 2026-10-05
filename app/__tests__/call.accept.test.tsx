import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as native from 'tacendum-call';
import * as calling from '../src/call';
import { PRESS_SHADE } from '../src/components/CallControls';
import * as db from '../src/db';
import { messaging } from '../src/messaging';
import { shortId } from '../src/person';
import { IncomingCallScreen } from '../src/screens/IncomingCallScreen';
import { ThemeProvider, themeTokens } from '../src/theme';

/**
 * Answering an incoming call (PLAN §7.5).
 *
 * The three outgoing paths have always asked for the microphone and camera
 * at the moment of the call. The two accept handlers called `accept()`
 * directly, so a first-ever call that was INCOMING put the system prompts
 * over the connecting screen — after `didActivate`, whose audio-unit start
 * then failed under the prompt — and a camera already refused was still
 * offered as "Answer with video", answered `vid:true`, and left the caller
 * staring at black.
 *
 * Three seams, all checked: the accept function itself, the screen's own
 * camera read, and App.tsx's wiring of the two buttons (source-level, the
 * way call.wiring.test.ts checks its seams — App.tsx has no unit harness).
 */

const CID = '01J0000000000000000000000T';
const PEER = '01PEERZ3NDEKTSV4RRFFQ69G5F';
const OFFER_SDP = 'v=0\r\na=fingerprint:sha-256 AA:BB\r\nOFFER';

let teardown: (() => void) | undefined;

async function flush(): Promise<void> {
  for (let i = 0; i < 60; i++) await Promise.resolve();
}

/** Ring this phone with a 1:1 offer through messaging's envelope listener. */
async function ringing(video: boolean): Promise<void> {
  jest.spyOn(messaging, 'onEnvelope');
  jest.spyOn(messaging, 'sendCallEnvelope').mockResolvedValue(undefined);
  // Someone this phone has HISTORY with (§10.6): the ring rule silences an
  // unknown caller, and this file has no database to hold a chat row.
  jest
    .spyOn(db, 'getChat')
    .mockResolvedValue({
      peerId: PEER,
      lastMessageAt: Date.now(),
    } as db.ChatRow);
  teardown = await calling.startCalling();
  const listener = (messaging.onEnvelope as jest.Mock).mock.calls.at(
    -1,
  )![0] as (
    peerId: string,
    envelope: unknown,
    meta: { msgId: string; ts: number },
  ) => void;
  listener(
    PEER,
    {
      tcm: 'call.offer',
      cid: CID,
      sdp: OFFER_SDP,
      vid: video,
      exp: Date.now() + 60_000,
    },
    { msgId: '01HQMSG000000000000000000C', ts: Date.now() },
  );
  await flush();
  await calling.callController().whenIdle();
  expect(calling.currentStateForTests().name).toBe('incoming_ringing');
}

beforeEach(() => {
  calling.resetCallingForTests();
  jest.clearAllMocks();
  (native.cameraPermission as jest.Mock)
    .mockReset()
    .mockResolvedValue('granted');
});

afterEach(() => {
  teardown?.();
  teardown = undefined;
  calling.resetCallingForTests();
  jest.restoreAllMocks();
});

describe('acceptIncomingCall asks for permissions FIRST', () => {
  it('asks before anything is answered, and answers with video when both are granted', async () => {
    await ringing(true);
    const order: string[] = [];
    (native.requestPermissions as jest.Mock).mockImplementation(async () => {
      order.push('ask');
      return { camera: 'granted', mic: 'granted' };
    });
    (native.createAnswer as jest.Mock).mockImplementation(async () => {
      order.push('answer');
      return 'v=0\r\na=fingerprint:sha-256 BB\r\nANSWER';
    });

    const result = await calling.acceptIncomingCall(true);
    await flush();

    expect(native.requestPermissions).toHaveBeenCalledWith(true);
    expect(order).toEqual(['ask', 'answer']);
    expect(result).toEqual({ ok: true, video: true });
    expect(calling.callController().state.call?.video).toBe(true);
  });

  it('degrades to an audio answer when the camera is refused at the prompt', async () => {
    await ringing(true);
    (native.requestPermissions as jest.Mock).mockResolvedValueOnce({
      camera: 'denied',
      mic: 'granted',
    });

    const result = await calling.acceptIncomingCall(true);
    await flush();

    expect(result).toEqual({ ok: true, video: false });
    expect(calling.callController().state.name).toBe('incoming_answering');
    expect(calling.callController().state.call?.video).toBe(false);
    // And the mirror agrees: no camera was promised.
    expect(calling.localMediaState().videoEnabled).toBe(false);
  });

  it('asks only for the microphone on "Answer without video"', async () => {
    await ringing(true);
    await calling.acceptIncomingCall(false);
    await flush();
    expect(native.requestPermissions).toHaveBeenCalledWith(false);
    expect(calling.callController().state.call?.video).toBe(false);
  });

  it('declines, with a reason, when the microphone is refused — a silent call is not an answer', async () => {
    await ringing(false);
    (native.requestPermissions as jest.Mock).mockResolvedValueOnce({
      camera: 'denied',
      mic: 'denied',
    });
    const sent = messaging.sendCallEnvelope as jest.Mock;
    sent.mockClear();

    const result = await calling.acceptIncomingCall(false);
    await flush();
    await calling.callController().whenIdle();

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Microphone/);
    expect(native.createAnswer).not.toHaveBeenCalled();
    expect(
      sent.mock.calls.some(
        c => c[1]?.tcm === 'call.end' && c[1]?.r === 'decline',
      ),
    ).toBe(true);
  });

  it('does nothing when the ring ended under the prompt', async () => {
    await ringing(false);
    let release: () => void = () => undefined;
    (native.requestPermissions as jest.Mock).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          release = () => resolve({ camera: 'granted', mic: 'granted' });
        }),
    );
    const accepting = calling.acceptIncomingCall(false);
    await flush();
    // The caller gives up while the prompt is showing.
    const listener = (messaging.onEnvelope as jest.Mock).mock.calls.at(
      -1,
    )![0] as (
      peerId: string,
      envelope: unknown,
      meta: { msgId: string; ts: number },
    ) => void;
    listener(
      PEER,
      { tcm: 'call.end', cid: CID, r: 'cancelled' },
      { msgId: '01HQMSG000000000000000000D', ts: Date.now() },
    );
    await flush();
    await calling.callController().whenIdle();
    const sent = messaging.sendCallEnvelope as jest.Mock;
    sent.mockClear();

    release();
    await accepting;
    await flush();

    expect(native.createAnswer).not.toHaveBeenCalled();
    expect(sent).not.toHaveBeenCalled();
  });
});

describe('the screen reads the camera itself when nobody tells it', () => {
  const METRICS = {
    frame: { x: 0, y: 0, width: 390, height: 844 },
    insets: { top: 47, left: 0, right: 0, bottom: 34 },
  };
  const mounted: ReactTestRenderer.ReactTestRenderer[] = [];
  afterEach(() => {
    ReactTestRenderer.act(() => {
      for (const t of mounted.splice(0)) t.unmount();
    });
  });

  async function mountScreen(
    over: Partial<React.ComponentProps<typeof IncomingCallScreen>> = {},
    settle = true,
  ) {
    const props = {
      peerId: '01HQBBBB00000000000000000A',
      peerName: 'Dana',
      withVideo: true,
      onAccept: jest.fn(),
      onAcceptAudioOnly: jest.fn(),
      onDecline: jest.fn(),
      ...over,
    };
    let tree!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(
        <SafeAreaProvider initialMetrics={METRICS}>
          <IncomingCallScreen {...props} />
        </SafeAreaProvider>,
      );
    });
    if (settle) {
      await ReactTestRenderer.act(async () => {
        await flush();
      });
    }
    mounted.push(tree);
    const byLabel = (label: string) =>
      tree.root.findAll(
        n => n.props.accessibilityLabel === label && typeof n.type !== 'string',
      )[0];
    const text = () =>
      tree.root
        .findAllByType(require('react-native').Text)
        .map(n =>
          Array.isArray(n.props.children)
            ? n.props.children.join('')
            : String(n.props.children ?? ''),
        )
        .join('\n');
    return { byLabel, text, props, tree };
  }

  const mount = (
    over: Partial<React.ComponentProps<typeof IncomingCallScreen>> = {},
  ) => mountScreen(over, true);
  const mountWithoutSettling = (
    over: Partial<React.ComponentProps<typeof IncomingCallScreen>> = {},
  ) => mountScreen(over, false);

  it('stops offering a video answer once the module says the camera was refused', async () => {
    (native.cameraPermission as jest.Mock).mockResolvedValue('denied');
    const { byLabel, text } = await mount();
    expect(byLabel('Answer with video')).toBeUndefined();
    expect(byLabel('Answer without video')).toBeUndefined();
    expect(byLabel('Answer')).toBeTruthy();
    expect(text()).toContain('Video isn’t available right now');
  });

  it('keeps video unavailable when the native status read fails', async () => {
    (native.cameraPermission as jest.Mock).mockRejectedValue(
      new Error('status unavailable'),
    );
    const { byLabel, text } = await mount();
    expect(byLabel('Answer with video')).toBeUndefined();
    expect(byLabel('Answer')).toBeTruthy();
    expect(text()).toContain('Video isn’t available right now');
  });

  it('keeps decline and audio usable without claiming video while the status read is pending', async () => {
    let release!: (value: 'denied') => void;
    (native.cameraPermission as jest.Mock).mockImplementation(
      () => new Promise(resolve => (release = resolve)),
    );
    const mountedNow = await mountWithoutSettling();
    expect(mountedNow.byLabel('Decline')).toBeTruthy();
    expect(mountedNow.byLabel('Answer without video')).toBeTruthy();
    expect(mountedNow.byLabel('Answer with video')).toBeUndefined();
    const checking = mountedNow.byLabel('Checking camera…');
    expect(checking).toBeTruthy();
    expect(checking.props.accessibilityState).toEqual({ disabled: true });

    await ReactTestRenderer.act(async () => {
      release('denied');
      await flush();
    });
    expect(mountedNow.byLabel('Checking camera…')).toBeUndefined();
    expect(mountedNow.byLabel('Answer')).toBeTruthy();
  });

  it('offers it while the camera is merely not yet asked for — the tap asks', async () => {
    (native.cameraPermission as jest.Mock).mockResolvedValue('undetermined');
    const { byLabel } = await mount();
    expect(byLabel('Answer with video')).toBeTruthy();
    expect(byLabel('Answer without video')).toBeTruthy();
  });

  it('does not ask for an audio invite, and honours an explicit prop over its own read', async () => {
    (native.cameraPermission as jest.Mock).mockResolvedValue('denied');
    await mount({ withVideo: false });
    expect(native.cameraPermission).not.toHaveBeenCalled();

    const { byLabel } = await mount({ cameraAvailable: true });
    expect(byLabel('Answer with video')).toBeTruthy();
  });

  it('routes the plain "Answer" of a refused camera to the audio handler', async () => {
    (native.cameraPermission as jest.Mock).mockResolvedValue('denied');
    const { byLabel, props } = await mount();
    ReactTestRenderer.act(() => {
      byLabel('Answer').props.onPress();
    });
    expect(props.onAcceptAudioOnly).toHaveBeenCalled();
    expect(props.onAccept).not.toHaveBeenCalled();
  });

  it('renders an unnamed caller as Someone and ?, never as a short account id', async () => {
    const peerId = '01J0000000000000000000000B';
    const unsafeName = shortId(peerId);
    const { text, tree } = await mount({ peerId, peerName: unsafeName });
    expect(text()).toContain('Someone');
    expect(text()).toContain('?');
    expect(text()).not.toContain(unsafeName);
    const labels = tree.root
      .findAll(n => typeof n.props.accessibilityLabel === 'string')
      .map(n => String(n.props.accessibilityLabel));
    expect(labels).toContain('Incoming video call from Someone');
    for (const label of labels) expect(label).not.toContain(unsafeName);
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

// Added for build 33. The incoming-call screen moved from media black
// to the white app ground, and its buttons still dimmed by opacity: the
// pending "Checking camera…" answer (every incoming video call opens on it)
// rendered mint under a white label at 2.52:1, and a pressed Answer or
// Decline lightened to 3.80:1 and 4.13:1.
describe('the answer buttons on the white app ground draw no state with opacity', () => {
  const METRICS = {
    frame: { x: 0, y: 0, width: 390, height: 844 },
    insets: { top: 47, left: 0, right: 0, bottom: 34 },
  };
  const trees: ReactTestRenderer.ReactTestRenderer[] = [];
  afterEach(() => {
    ReactTestRenderer.act(() => {
      for (const t of trees.splice(0)) t.unmount();
    });
  });

  async function mountIn(mode: 'light' | 'dark'): Promise<ReactTestRenderer.ReactTestRenderer> {
    let tree!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(
        <SafeAreaProvider initialMetrics={METRICS}>
          <ThemeProvider mode={mode}>
            <IncomingCallScreen
              peerId="01HQBBBB00000000000000000A"
              peerName="Dana"
              withVideo
              onAccept={jest.fn()}
              onAcceptAudioOnly={jest.fn()}
              onDecline={jest.fn()}
            />
          </ThemeProvider>
        </SafeAreaProvider>,
      );
    });
    await ReactTestRenderer.act(async () => {
      await flush();
    });
    trees.push(tree);
    return tree;
  }

  /** One button, pressed or not: its own style, the label's colour and the
   * press shade its children draw, read off the Pressable's two functions. */
  function button(tree: ReactTestRenderer.ReactTestRenderer, label: string, pressed: boolean) {
    const press = tree.root.findAll(
      n => n.props.accessibilityLabel === label && typeof n.props.style === 'function',
    )[0]!;
    const style = StyleSheet.flatten(press.props.style({ pressed })) as {
      opacity?: number;
      backgroundColor?: string;
      borderWidth?: number;
      borderColor?: string;
    };
    let inner!: ReactTestRenderer.ReactTestRenderer;
    ReactTestRenderer.act(() => {
      inner = ReactTestRenderer.create(
        <View>{press.props.children({ pressed, hovered: false })}</View>,
      );
    });
    trees.push(inner);
    const words = inner.root.findAllByType(Text)[0]!;
    const shade = inner.root.findAll(
      n => n.props.testID === 'call-press-shade' && typeof n.type === 'string',
    )[0];
    return {
      style,
      ink: StyleSheet.flatten(words.props.style).color as string,
      shade: shade ? StyleSheet.flatten(shade.props.style) : null,
    };
  }

  it('the pending answer is the house’s disabled button: the gray inset, a soft ring, a muted label', async () => {
    (native.cameraPermission as jest.Mock).mockImplementation(() => new Promise(() => undefined));
    for (const mode of ['light', 'dark'] as const) {
      const t = themeTokens(mode);
      const tree = await mountIn(mode);
      const pending = button(tree, 'Checking camera…', false);
      expect(pending.style.opacity ?? 1).toBe(1);
      expect(pending.style).toMatchObject({
        backgroundColor: t.color.paperInset,
        borderWidth: 1,
        borderColor: t.color.lineSoft,
      });
      expect(pending.ink).toBe(t.color.inkMuted);
      expect(contrast(pending.ink, pending.style.backgroundColor!)).toBeGreaterThanOrEqual(4.5);
      expect(pending.shade).toBeNull();
    }
  });

  it('a finger on Answer or Decline darkens the disc with the shade, and the white label stays above 4.5:1', async () => {
    for (const mode of ['light', 'dark'] as const) {
      const t = themeTokens(mode);
      const tree = await mountIn(mode);
      for (const [label, disc] of [
        ['Answer with video', t.color.mediaAccent],
        ['Decline', t.color.mediaDanger],
      ] as const) {
        const resting = button(tree, label, false);
        expect(resting.style.backgroundColor).toBe(disc);
        expect(resting.shade).toBeNull();
        const down = button(tree, label, true);
        expect(down.style.opacity ?? 1).toBe(1);
        expect(down.style.backgroundColor).toBe(disc);
        expect(down.shade).toMatchObject({
          position: 'absolute',
          borderRadius: 28,
          backgroundColor: t.color.mediaBlack,
          opacity: PRESS_SHADE,
        });
        expect(down.ink).toBe(t.color.mediaInk);
        const shaded = composite(t.color.mediaBlack, PRESS_SHADE, disc);
        expect(contrast(down.ink, shaded)).toBeGreaterThanOrEqual(4.5);
        // The dip it replaces, over the white page: under 4.5:1.
        expect(contrast(down.ink, composite(disc, 0.75, '#FFFFFF'))).toBeLessThan(4.5);
      }
    }
  });

  it('a finger on the neutral answer fills it with the gray pressed fill, never a dim', async () => {
    const t = themeTokens('light');
    const tree = await mountIn('light');
    const resting = button(tree, 'Answer without video', false);
    expect(resting.style).toMatchObject({
      backgroundColor: t.color.paperSheet,
      borderColor: t.color.lineStrong,
    });
    const down = button(tree, 'Answer without video', true);
    expect(down.style.opacity ?? 1).toBe(1);
    expect(down.style.backgroundColor).toBe(t.color.paperInset);
    expect(down.ink).toBe(t.color.inkStrong);
    expect(down.shade).toBeNull();
  });
});

describe('App.tsx wires both buttons through the permission-first accept', () => {
  it('never calls accept() directly from the incoming screen', () => {
    const fs = jest.requireActual<{
      readFileSync(p: string, e: string): string;
    }>('fs');
    const testPath = expect.getState().testPath ?? '';
    const appDir = testPath.slice(0, testPath.lastIndexOf('/__tests__/'));
    const src = fs.readFileSync(`${appDir}/App.tsx`, 'utf8');
    const start = src.indexOf('<IncomingCallScreen');
    expect(start).toBeGreaterThan(0);
    const block = src.slice(start, src.indexOf('/>', start));
    expect(block).toMatch(
      /onAccept=\{\(\) => void acceptIncomingCall\(true\)\}/,
    );
    expect(block).toMatch(
      /onAcceptAudioOnly=\{\(\) => void acceptIncomingCall\(false\)\}/,
    );
    expect(block).not.toMatch(/callController\(\)\.accept\(/);
    // No hand-set `cameraAvailable`: the screen reads the module itself.
    expect(block).not.toMatch(/cameraAvailable=/);
  });
});
