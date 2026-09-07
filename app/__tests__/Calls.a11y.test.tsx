/**
 * THE CALL LANE, REACHABLE.
 *
 * Four defects, one file, because they are one complaint: a person using
 * VoiceOver could open a chat from the Calls tab but could not call anybody
 * back, was not told a call had a camera on it, was never told the connection
 * had gone poor, and heard an unnamed caller read out as characters of their
 * account id.
 *
 * The nesting rule this suite enforces is the codebase's own, stated in this
 * exact lane at CallOverlay.tsx:274-276 — "A SIBLING of the restore surface,
 * not a child: a Pressable inside an accessible Pressable is unreachable to
 * VoiceOver". iOS merges an accessible container's subtree into ONE element,
 * so a button inside a labelled row is not a button any more; it is part of
 * the row's label.
 */

jest.mock('../src/db', () => ({
  listAllCalls: jest.fn(),
  listChats: jest.fn(),
}));

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import type { CallState } from '@tacendum/shared';
import * as db from '../src/db';
import { CallsScreen } from '../src/screens/CallsScreen';
import { CallScreen } from '../src/screens/CallScreen';
import { QualityBars } from '../src/components/CallControls';
import { UNNAMED } from '../src/ui/CallTile';
import { shortId } from '../src/person';
import { themeTokens } from '../src/theme';

const listAllCalls = db.listAllCalls as jest.MockedFunction<
  typeof db.listAllCalls
>;
const listChats = db.listChats as jest.MockedFunction<typeof db.listChats>;

const T0 = new Date('2026-07-25T12:00:00').getTime();
const CALL = {
  cid: '01CALLB0000000000000000002',
  peerId: 'peer-2',
  direction: 'out' as const,
  kind: 'video' as const,
  state: 'ended' as const,
  reason: 'hangup',
  startedAt: T0,
  connectedAt: T0 + 4_000,
  endedAt: T0 + 34_000,
  lastSeenAt: T0 + 34_000,
  missed: 0,
};

beforeEach(() => {
  jest.clearAllMocks();
  listAllCalls.mockResolvedValue([CALL]);
  listChats.mockResolvedValue([
    { peerId: 'peer-2', displayName: '', localName: 'Dawit', avatarB64: null },
  ] as never);
});

const mounted: ReactTestRenderer.ReactTestRenderer[] = [];
afterEach(() => {
  ReactTestRenderer.act(() => {
    for (const t of mounted.splice(0)) t.unmount();
  });
});

async function renderCalls(onCall = jest.fn()) {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <CallsScreen onOpenChat={jest.fn()} onCall={onCall} />,
    );
  });
  await ReactTestRenderer.act(async () => {});
  mounted.push(tree);
  return { tree, onCall };
}

/**
 * Every ancestor that would swallow this node on iOS: an explicitly
 * accessible container, or one carrying a role and a label, which is what
 * makes a container accessible by default.
 */
function accessibleAncestors(
  node: ReactTestRenderer.ReactTestInstance,
): ReactTestRenderer.ReactTestInstance[] {
  const out: ReactTestRenderer.ReactTestInstance[] = [];
  let cursor = node.parent;
  while (cursor) {
    const p = cursor.props as {
      accessible?: boolean;
      accessibilityRole?: string;
      accessibilityLabel?: string;
    };
    if (
      p.accessible === true ||
      (p.accessibilityRole === 'button' &&
        typeof p.accessibilityLabel === 'string')
    ) {
      out.push(cursor);
    }
    cursor = cursor.parent;
  }
  return out;
}

describe('the Calls tab can be operated with VoiceOver', () => {
  it('puts redial BESIDE the row, never inside it', async () => {
    const { tree } = await renderCalls();
    const redial = tree.root.findAll(
      n =>
        typeof n.type !== 'string' &&
        n.props.accessibilityLabel === 'Video call Dawit' &&
        typeof n.props.onPress === 'function',
    )[0]!;
    expect(redial).toBeDefined();
    // FALSIFYING CASE, run at authoring time: with the redial back inside the
    // row Pressable this finds the row and the assertion goes red, which is
    // the state that shipped.
    expect(
      accessibleAncestors(redial).map(n => n.props.accessibilityLabel),
    ).toEqual([]);
  });

  it('offers Call back as a rotor action on the row itself', async () => {
    const { tree, onCall } = await renderCalls();
    const row = tree.root.findAll(
      n =>
        typeof n.type !== 'string' &&
        String(n.props.accessibilityLabel ?? '').startsWith('Dawit,'),
    )[0]!;
    expect(row.props.accessibilityActions).toEqual([
      { name: 'call-back', label: 'Call back' },
    ]);
    await ReactTestRenderer.act(async () => {
      row.props.onAccessibilityAction({
        nativeEvent: { actionName: 'call-back' },
      });
    });
    expect(onCall).toHaveBeenCalledWith('peer-2', 'video');
  });

  it('passes a system action through without redialling', async () => {
    // The same prop carries activate/magicTap. Anything not ours is ignored,
    // the pip's rule (pipCornerForAction) applied here.
    const { tree, onCall } = await renderCalls();
    const row = tree.root.findAll(
      n =>
        typeof n.type !== 'string' &&
        String(n.props.accessibilityLabel ?? '').startsWith('Dawit,'),
    )[0]!;
    await ReactTestRenderer.act(async () => {
      row.props.onAccessibilityAction({
        nativeEvent: { actionName: 'magicTap' },
      });
    });
    expect(onCall).not.toHaveBeenCalled();
  });
});

const T = 1_800_000_000_000;

function callState(
  over: Partial<NonNullable<CallState['call']>> & {
    name?: CallState['name'];
  } = {},
): CallState {
  const { name = 'connected', ...call } = over;
  return {
    name,
    call: {
      cid: '01J0000000000000000000000A',
      peerId: 'P1',
      direction: 'out',
      video: false,
      peerAudio: true,
      peerVideo: false,
      startedAt: T - 60_000,
      connectedAt: T - 65_000,
      remoteOfferSdp: '',
      pendingIce: [],
      remoteReady: true,
      ...call,
    },
  } as CallState;
}

function renderCall(
  over: Partial<React.ComponentProps<typeof CallScreen>> = {},
) {
  const props = {
    state: callState(),
    peerName: 'Dana',
    muted: false,
    videoEnabled: false,
    speakerOn: false,
    frontCamera: true,
    onToggleMute: jest.fn(),
    onToggleVideo: jest.fn(),
    onFlipCamera: jest.fn(),
    onToggleSpeaker: jest.fn(),
    onHangup: jest.fn(),
    now: () => T,
    ...over,
  };
  let tree!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 47, left: 0, right: 0, bottom: 34 },
        }}
      >
        <CallScreen {...props} />
      </SafeAreaProvider>,
    );
  });
  mounted.push(tree);
  return tree;
}

function texts(node: ReactTestRenderer.ReactTestInstance): string[] {
  return node
    .findAll(n => String(n.type) === 'Text')
    .flatMap(n => [n.props.children].flat())
    .filter((c): c is string => typeof c === 'string');
}

describe('the 1:1 call screen says what kind of call it is, and never says an id', () => {
  it('puts video kind and state on the accessible live status leaf', () => {
    const tree = renderCall({
      state: callState({ name: 'reconnecting', video: true, peerVideo: true }),
      videoEnabled: true,
    });
    const status = tree.root.findAll(
      n =>
        typeof n.type !== 'string' &&
        n.props.accessibilityLabel === 'Video call, Reconnecting',
    )[0]!;
    expect(status).toBeDefined();
    expect(status.props.accessibilityLiveRegion).toBe('polite');
    expect(accessibleAncestors(status)).toEqual([]);
  });

  it('puts audio kind and state on the same reachable status leaf', () => {
    const tree = renderCall();
    const status = tree.root.findAll(
      n =>
        typeof n.type !== 'string' &&
        n.props.accessibilityLabel === 'Call, Connected',
    )[0]!;
    expect(status).toBeDefined();
    expect(accessibleAncestors(status)).toEqual([]);
  });

  it('speaks the placeholder for an unnamed peer in the header AND both video labels', () => {
    // App.tsx's fallback is personName(peerId), which is the shortId
    // fragment — the id arriving dressed as a name. CallTile's rule 2 refuses
    // both forms; this screen kept neither before.
    const peerId = '01J0000000000000000000000B';
    const tree = renderCall({
      state: callState({ peerId, video: true, peerVideo: true }),
      peerName: shortId(peerId),
      videoEnabled: true,
    });
    const spoken = tree.root
      .findAll(n => typeof n.props.accessibilityLabel === 'string')
      .map(n => String(n.props.accessibilityLabel));
    expect(spoken).toContain(`${UNNAMED}'s video, full screen`);
    for (const label of spoken) expect(label).not.toContain(shortId(peerId));
    // The header line a sighted person reads, too.
    expect(texts(tree.root)).toContain(UNNAMED);
    expect(texts(tree.root).join('\n')).not.toContain(shortId(peerId));
  });
});

describe('the connection-quality bars are an element a screen reader can stop on', () => {
  it('carries `accessible`, not a label on an inert View', () => {
    // RN's View defaults accessible to false, so a labelled View with no
    // `accessible` is never focused and "Connection poor" is never spoken.
    let tree!: ReactTestRenderer.ReactTestRenderer;
    ReactTestRenderer.act(() => {
      tree = ReactTestRenderer.create(
        <QualityBars level={1} theme={themeTokens()} />,
      );
    });
    mounted.push(tree);
    const bars = tree.root.findAll(
      n => n.props.accessibilityLabel === 'Connection poor',
    )[0]!;
    expect(bars.props.accessible).toBe(true);
  });
});
