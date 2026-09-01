/**
 * The small-group call screen.
 *
 * The screen holds no session state and touches no native module, which is why
 * a five-way call in any combination of failure states is renderable here with
 * no device and no clock.
 *
 * What is guarded hardest is not visual:
 *
 *  - every `LegPhase` renders a DISTINCT, named string, and "Couldn't reach"
 *    and "May be offline" stay two different sentences about two different
 *    facts (its own falsifier: collapse them and two tests go red);
 *  - no surface renders a sid, a cid or a member id — including the id
 *    FRAGMENT `personName` falls back to, which is fine in a chat list and
 *    forbidden here;
 *  - mute renders from the coordinator's post-fan-out verdict, never
 *    optimistically, so a muted glyph can never sit over a live microphone;
 *  - the cap copy is byte-exact and the cap itself comes from the shared
 *    module, audio and video apart.
 *
 * The `CallPicker` is exercised here too, and for the second reason above:
 * it is the other surface that lists PEOPLE during a call, so the naming rule
 * is one rule across both or it is not a rule.
 *
 * Harness follows CallScreen.test.tsx: react-test-renderer inside a
 * SafeAreaProvider, because `useSafeAreaInsets` needs native measurements that
 * do not exist here and every screen renders empty without it.
 */

import React, { useState } from 'react';
import { Text, View, StyleSheet } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import {
  SMALL_GROUP_CALL_MAX_PARTICIPANTS,
  SMALL_GROUP_CALL_MAX_VIDEO_PARTICIPANTS,
} from '@tacendum/shared';
import type { LegPhase } from '@tacendum/shared/call-session';
import type {
  GroupCallView,
  GroupLegView,
  LegFanOutcome,
} from '../src/call/group';
import {
  CALL_CAP_COPY,
  GroupCallScreen,
  gridColumns,
  gridRows,
  rosterSubtitle,
  sessionStatusLabel,
  type GroupCallScreenProps,
} from '../src/screens/GroupCallScreen';
import {
  MAY_BE_OFFLINE,
  MAY_BE_OFFLINE_MS,
  UNNAMED,
  legStatusLabel,
  tileAccessibilityLabel,
  tileName,
} from '../src/ui/CallTile';
import { CallPicker } from '../src/ui/CallPicker';
// The chat's own avatar component, asserted by type: "the same picture the
// thread shows" is a claim about the SOURCE, and the only way to keep it true
// is for both surfaces to be the same component reading the same column.
import { Avatar } from '../src/ui/Avatar';
import { shortId } from '../src/person';
import * as calling from '../src/call';
import * as db from '../src/db';
// THE APP GRAPH LOADS HERE, AT SUITE SETUP — NEVER INSIDE A TEST'S CLOCK.
// Four tests below render the real App. The first of them used to load it
// with `jest.requireActual('../App')` mid-test, which charged the one-time
// babel transform of App.tsx and everything it imports to that one test's
// five-second budget. A warm-cached dev machine never notices; CI — always a
// cold cache, workers sharing four vCPUs — paid ~11 s on x86_64, timed out,
// and the abandoned render's act() work then corrupted a later test's hook
// order ("Should have a queue" in `wires the speaker button`): fourteen red
// runs with no code defect. There is no jest.mock for '../App', so a
// top-level import is the same module through the same registry — it just
// pays for itself before any test's timer starts, exactly as
// App.appgroup.test.tsx already loads it. The per-test spies still land
// because they patch the shared module-exports objects that App reads at
// render time, not at import time.
import App from '../App';

// AND THE RENDER PAYS A COLD-CACHE TAX THE IMPORT CANNOT: react-native's
// index is lazy getters, so the first test to RENDER the App still transforms
// dozens of component modules on demand — ~4.5 s of the CI failure survived
// the hoist above. The sibling App-rendering suites (GroupCreate,
// GroupProfile.send, messaging.groups.send) set the same file-level budget
// for the same reason. This is a ceiling for environmental cost, not a
// license: a genuine hang still fails, at 120 s instead of 5. It is
// file-level rather than per-test because a timeout ANYWHERE in this file is
// never just one red test — the abandoned async act() work keeps flushing
// into whichever test runs next and corrupts its hook order, which is
// exactly how one slow require became two CI failures.
jest.setTimeout(120_000);

const T = 1_800_000_000_000;

/** Valid Crockford ULIDs (no I, L, O, U), 26 characters. */
const ulid = (tag: string) => (tag + '0'.repeat(26)).slice(0, 26);
const SID = ulid('SESSION');
/** A SECOND session, for the glare swap: the coordinator replaces the session
 * in place and this component never unmounts. */
const SID_B = ulid('SESSNB');
const ME = ulid('ME1');
const ANA = ulid('ANA');
const BEN = ulid('BEN');
const CARA = ulid('CARA');
const DEE = ulid('DEE');
const EVE = ulid('EVE');
const ROOM = ulid('R00M');
const ROOM_B = ulid('R00MB');
/** The cids a fan reports acting on (`LegFanOutcome.cid`). The screen does not
 * read them — it reads the verdict beside them — but an outcome that named
 * only a PERSON is what let a live participant be reported as dropped. */
const ANA_CID = ulid('CIDANA');
const BEN_CID = ulid('CIDBEN');
const CARA_CID = ulid('CIDCARA');

const NAMES: Record<string, string> = {
  [ANA]: 'Ana',
  [BEN]: 'Ben',
  [CARA]: 'Cara',
  [DEE]: 'Dee',
  [EVE]: 'Eve',
};

/**
 * A leg as the COORDINATOR publishes it.
 *
 * `invitedAt` defaults to `T` for a leg that is still waiting and to null for
 * every other phase, which is exactly what `syncInvitedAt` produces — the
 * anchor is stamped while a leg is `inviting` and cleared the moment anything
 * comes back. Tests that care about the eight seconds pass their own.
 */
const leg = (
  peerId: string,
  phase: LegPhase,
  skipped: GroupLegView['skipped'] = null,
  invitedAt: number | null = phase === 'inviting' ? T : null,
): GroupLegView => ({ peerId, phase, skipped, invitedAt });

function view(over: Partial<GroupCallView> = {}): GroupCallView {
  return {
    sid: SID,
    // THE COORDINATOR'S OPAQUE SESSION KEY (`sessionIncarnation`), which is
    // what this screen compares — never the sid, which a remote starter mints
    // and can therefore repeat across two different calls.
    sessionKey: 1,
    starterId: ME,
    selfId: ME,
    roomId: null,
    roster: [ME, ANA, BEN],
    video: false,
    phase: 'live',
    legs: [leg(ANA, 'connected'), leg(BEN, 'ringing')],
    startedAt: T - 60_000,
    connectedAt: T - 65_000,
    muted: false,
    speakerOn: false,
    ...over,
  };
}

const mounted: ReactTestRenderer.ReactTestRenderer[] = [];
afterEach(() => {
  ReactTestRenderer.act(() => {
    for (const t of mounted.splice(0)) t.unmount();
  });
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Lets a test replace the view mid-flight, which is how the coordinator's
 * fan-out actually reaches this screen: it closes a leg and republishes. */
let pushView: ((v: GroupCallView) => void) | null = null;

function Harness({
  initial,
  ...rest
}: { initial: GroupCallView } & Omit<GroupCallScreenProps, 'view'>) {
  const [v, setV] = useState(initial);
  pushView = setV;
  return <GroupCallScreen view={v} {...rest} />;
}

function render(
  over: Partial<GroupCallScreenProps> & { view?: GroupCallView } = {},
) {
  const { view: initial = view(), ...rest } = over;
  const props: Omit<GroupCallScreenProps, 'view'> = {
    nameFor: (id: string) => NAMES[id] ?? null,
    onToggleMute: jest.fn(),
    onToggleSpeaker: jest.fn(),
    onEnd: jest.fn(),
    now: () => T,
    ...rest,
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
        <Harness initial={initial} {...props} />
      </SafeAreaProvider>,
    );
  });
  mounted.push(tree);
  const byLabel = (label: string) =>
    tree.root.findAll(
      n => n.props.accessibilityLabel === label && typeof n.type !== 'string',
    )[0];
  return { tree, props, byLabel };
}

function renderedText(tree: ReactTestRenderer.ReactTestRenderer): string {
  return tree.root
    .findAllByType(Text)
    .map(n =>
      Array.isArray(n.props.children)
        ? n.props.children.join('')
        : String(n.props.children ?? ''),
    )
    .join('\n');
}

/** Every accessibility label in the tree, tiles included. */
function labels(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  return tree.root
    .findAll(n => typeof n.props.accessibilityLabel === 'string')
    .map(n => String(n.props.accessibilityLabel));
}

const ALL_PHASES: LegPhase[] = [
  'inviting',
  'ringing',
  'unreachable',
  'connecting',
  'connected',
  'reconnecting',
  'failed',
  'declined',
  'left',
  'gone',
];

describeAppOwnedStateAcrossCoordinatorSessions();

describe('tile status lines', () => {
  it('gives every LegPhase a distinct, named string', () => {
    // The rule twice over: a tile is never blank, and two phases never share
    // a sentence. Collapsing any pair — "gone" onto "left", say — fails here.
    const copies = ALL_PHASES.map(phase => legStatusLabel({ peerId: ANA, phase, skipped: null }));
    for (const copy of copies) expect(copy.trim()).not.toBe('');
    expect(new Set(copies).size).toBe(ALL_PHASES.length);
  });

  it('keeps "Couldn’t reach" and "May be offline" apart', () => {
    // Two different facts. `unreachable` is KNOWLEDGE — the push mirror was
    // empty when we sent — and "May be offline" is ignorance: the invite went
    // out and nothing came back. The design names them separately; the falsifying
    // case is a mapping that returns one string for both.
    const reach = legStatusLabel({ peerId: ANA, phase: 'unreachable', skipped: null });
    const silent = legStatusLabel(
      { peerId: ANA, phase: 'inviting', skipped: null },
      MAY_BE_OFFLINE_MS,
    );
    expect(reach).toBe('Couldn’t reach');
    expect(silent).toBe(MAY_BE_OFFLINE);
    expect(reach).not.toBe(silent);
  });

  it('says "Calling…" until the invite has been silent long enough', () => {
    const l = { peerId: ANA, phase: 'inviting' as const, skipped: null };
    expect(legStatusLabel(l, MAY_BE_OFFLINE_MS - 1)).toBe('Calling…');
    expect(legStatusLabel(l, MAY_BE_OFFLINE_MS)).toBe(MAY_BE_OFFLINE);
  });

  it('lets a safety skip outrank the phase', () => {
    // A leg that was never opened must not read as "Calling…" — nothing is
    // being dialled, and the reason is one the person can act on.
    expect(legStatusLabel({ peerId: ANA, phase: 'inviting', skipped: 'blocked' })).toBe(
      'Not called — you blocked them',
    );
    expect(
      legStatusLabel({ peerId: ANA, phase: 'inviting', skipped: 'identity_changed' }),
    ).toBe('Not called — their safety number changed');
  });

  it('turns "Calling…" into "May be offline" as the clock passes, in a live tree', () => {
    let clock = T;
    const { tree } = render({
      view: view({ legs: [leg(ANA, 'inviting')], connectedAt: null }),
      now: () => clock,
    });
    expect(renderedText(tree)).toContain('Calling…');
    ReactTestRenderer.act(() => {
      clock = T + MAY_BE_OFFLINE_MS;
      jest.advanceTimersByTime(1000);
    });
    expect(renderedText(tree)).toContain(MAY_BE_OFFLINE);
  });

  it('reads the anchor from the VIEW, so a remount cannot reset it', () => {
    // The design: status derives from coordinator state, never from a view timer. The
    // screen used to stamp its own map on first render, so a leg that had been
    // silent for twelve seconds read "Calling…" again the moment this
    // component was rebuilt — rotate the phone, navigate away and back, or
    // simply mount late, and the sentence changed for reasons that had nothing
    // to do with the call.
    //
    // FALSIFYING CASE, run at authoring time: restore the screen-owned
    // `invitedAt` ref. The first render then measures zero milliseconds of
    // silence for a leg the coordinator says has been waiting since T - 12s,
    // and BOTH assertions below fail.
    const waiting = view({
      legs: [leg(ANA, 'inviting', null, T - 12_000)],
      connectedAt: null,
    });
    const first = render({ view: waiting, now: () => T });
    expect(renderedText(first.tree)).toContain(MAY_BE_OFFLINE);
    // Asserted on the TILE and not on the page text: the header's own status
    // line says "Calling…" for an inviting session either way, and that is a
    // different sentence about a different thing.
    expect(labels(first.tree)).toContain('Ana, may be offline');

    // The same view, a brand new component tree: the same answer.
    ReactTestRenderer.act(() => {
      first.tree.unmount();
    });
    const second = render({ view: waiting, now: () => T });
    expect(renderedText(second.tree)).toContain(MAY_BE_OFFLINE);
    expect(labels(second.tree)).toContain('Ana, may be offline');
    expect(labels(second.tree)).not.toContain('Ana, calling');
  });

  it('dates each leg from when IT was invited, not from the session', () => {
    // A participant added at minute three has not been silent for three
    // minutes. Anchoring on `view.startedAt` would put "May be offline" under
    // their name the instant they were invited — which is the falsifying case.
    let clock = T;
    const { tree } = render({
      view: view({
        roster: [ME, ANA],
        legs: [leg(ANA, 'connected')],
        startedAt: T - 600_000,
        connectedAt: T - 600_000,
      }),
      now: () => clock,
    });
    ReactTestRenderer.act(() => {
      pushView?.(
        view({
          roster: [ME, ANA, BEN],
          legs: [leg(ANA, 'connected'), leg(BEN, 'inviting')],
          startedAt: T - 600_000,
          connectedAt: T - 600_000,
        }),
      );
    });
    ReactTestRenderer.act(() => {
      clock = T + 1000;
      jest.advanceTimersByTime(1000);
    });
    expect(renderedText(tree)).toContain('Calling…');
    expect(renderedText(tree)).not.toContain(MAY_BE_OFFLINE);
  });
});

describe('names, and the ids that must never appear', () => {
  it('renders the placeholder for an unnamed member, never the id', () => {
    const { tree } = render({ view: view(), nameFor: () => null });
    const text = renderedText(tree);
    expect(text).toContain(UNNAMED);
    for (const id of [SID, ME, ANA, BEN]) expect(text).not.toContain(id);
  });

  it('refuses personName’s id fragment as a tile label', () => {
    // `personName` falls back to `shortId`. Legitimate in a chat list, and
    // forbidden here — the in-call surface is the one a stranger holding the
    // phone sees. The falsifying case is passing the fallback straight
    // through, which renders "…0000000A" under someone's face.
    expect(tileName(ANA, shortId(ANA))).toBe(UNNAMED);
    expect(tileName(ANA, ANA)).toBe(UNNAMED);
    expect(tileName(ANA, '   ')).toBe(UNNAMED);
    // A real name that merely looks id-ish is still a name.
    expect(tileName(ANA, 'Ana')).toBe('Ana');
    expect(tileName(CARA, 'Cara')).toBe('Cara');
  });

  it('renders no sid, cid or member id anywhere on the screen', () => {
    const { tree } = render({
      view: view({
        roomId: ROOM,
        roster: [ME, ANA, BEN, CARA],
        legs: [leg(ANA, 'connected'), leg(BEN, 'failed'), leg(CARA, 'declined')],
      }),
      roomName: 'Kitchen',
    });
    const everything = [renderedText(tree), ...labels(tree)].join('\n');
    for (const id of [SID, ROOM, ME, ANA, BEN, CARA]) {
      expect(everything).not.toContain(id);
    }
    expect(everything).toContain('Kitchen');
  });

  it('refuses a room name that is really the room id', () => {
    const { tree } = render({ view: view({ roomId: ROOM }), roomName: ROOM });
    expect(renderedText(tree)).not.toContain(ROOM);
    // Falls back to the roster, in local names.
    expect(renderedText(tree)).toContain('Ana and Ben');
  });
});

/**
 * THE ROOM ARM OF THE DARK RECTANGLE (a hardware report).
 *
 * The report was about a 1:1 video call and ended "that goes the same for
 * room call". A room call has no video surface at all — mesh video is
 * cut for v1 — so the tile is the whole of what a participant looks like, and
 * it drew a monogram on pine while the thread beside it drew that person's
 * face. Same person, same database row, two different pictures.
 *
 * The photo comes from the CALLER, exactly as the name does: this tile reads
 * nothing and subscribes to nothing, so `avatarFor` is the sibling of
 * `nameFor` rather than a database call growing inside a view.
 */
describe('a tile is a person, not a monogram', () => {
  const PHOTOS: Record<string, string> = {
    [ANA]: '/9j/4AAQSkZJRgABAQAAAQABAAD==',
  };

  it('draws the person’s picture from the chat’s own column', () => {
    const { tree } = render({
      view: view({ legs: [leg(ANA, 'connected'), leg(BEN, 'ringing')] }),
      avatarFor: (id: string) => PHOTOS[id] ?? null,
    });
    const faces = tree.root.findAllByType(Avatar);
    expect(faces.map(f => f.props.photoB64)).toContain(PHOTOS[ANA]);
    // And the tile it is on is Ana's, not whoever happened to be first.
    // `findAll` on a testID matches the component AND the host views it
    // forwards the prop to, so the outermost match is the tile itself.
    const ana = tree.root
      .findAll(n => n.props.testID === `group-call-tile-${ANA}`)[0]!
      .findAllByType(Avatar);
    expect(ana).toHaveLength(1);
    expect(ana[0]!.props.photoB64).toBe(PHOTOS[ANA]);
    // Ben has no photo, so his tile keeps the placeholder: the picture is
    // per-person, not a flag that turns the treatment on for the whole grid.
    const ben = tree.root.findAll(
      n => n.props.testID === `group-call-tile-${BEN}`,
    )[0]!;
    expect(ben.findAllByType(Avatar)).toHaveLength(0);
    // AND THE TWO DISCS ARE THE SAME SIZE. A grid whose cells change shape
    // according to who happens to have shared a photo reflows around a fact
    // about other people's profiles.
    const disc = ben
      .findAll(n => typeof StyleSheet.flatten(n.props.style)?.borderRadius === 'number')
      .map(n => StyleSheet.flatten(n.props.style))
      .find(s => s.width === s.height && typeof s.width === 'number')!;
    expect(ana[0]!.props.size).toBe(disc.width);
  });

  it('leaves the standard placeholder alone for someone with no picture', () => {
    // Ben has no photo. The tile must NOT fall through to `Avatar`'s own
    // no-name fallback, which is two characters of the ULID — legitimate in a
    // chat list and forbidden on the one surface a stranger holding the phone
    // sees.
    const { tree } = render({
      view: view({ legs: [leg(BEN, 'ringing')] }),
      avatarFor: (id: string) => PHOTOS[id] ?? null,
      nameFor: () => null,
    });
    const text = renderedText(tree);
    expect(text).toContain(UNNAMED);
    expect(text).toContain('?');
    for (const id of [BEN, shortId(BEN)]) expect(text).not.toContain(id);
  });

  it('never reaches for an id when a picture fails to decode', () => {
    // `Avatar` falls back to `monogram(peerId, displayName)` when the blob is
    // truncated or not actually JPEG — and `monogram`'s no-name branch is two
    // characters of the ULID. Handing it a photo but no name is the one path
    // that could put an id on a tile, so the name goes down with the picture.
    const { tree } = render({
      view: view({ legs: [leg(ANA, 'connected')] }),
      avatarFor: (id: string) => PHOTOS[id] ?? null,
      nameFor: () => null,
    });
    const image = tree.root.findAll(
      n => typeof n.props?.source?.uri === 'string',
    )[0]!;
    ReactTestRenderer.act(() => image.props.onError());
    const text = renderedText(tree);
    for (const id of [ANA, shortId(ANA), ANA.slice(-2)]) {
      expect(text).not.toContain(id);
    }
    expect(text).toContain(UNNAMED);
  });

  it('degrades to the monogram for a caller that omits avatarFor', () => {
    // `avatarFor` is optional so a non-adopter gets exactly the screen it
    // had — a monogram, never a broken image and never an id. This is the
    // FALLBACK contract, not the shipped state: App.tsx wires the prop, and
    // the App-rendering test below ('hands the tile the picture App
    // resolved…') is the one that goes red if that wiring is ever dropped.
    // Every other test in this describe injects `avatarFor` itself, which is
    // precisely how the prop once shipped unadopted with a green suite.
    const { tree } = render({ view: view({ legs: [leg(ANA, 'connected')] }) });
    expect(tree.root.findAllByType(Avatar)).toHaveLength(0);
    expect(renderedText(tree)).toContain('AN');
  });
});

describe('the picker’s names', () => {
  /**
   * THE SAME RULE, ON THE OTHER GROUP-CALL SURFACE. The picker is where a room
   * bigger than a call chooses its seats, and it lists PEOPLE — so `tileName`'s
   * rule is its rule too. It applies it itself rather than trusting the two
   * call sites that build its candidates: App.tsx's Add picker and the room
   * thread's, one of which reached for `personName`'s id fragment and the other
   * for a label that can echo an id.
   *
   * Ids with DISTINCTIVE TAILS, because `shortId` shows the last eight
   * characters and the zero-padded ids above all share theirs — a leaked
   * fragment has to be attributable to be worth asserting on.
   */
  const tailId = (tag: string) => ('0'.repeat(26) + tag).slice(-26);
  const NOBODY = tailId('K7CHN9Q');
  const SELF_TITLED = tailId('X4PVR2T');
  const NAMED = tailId('W8MZD6B');

  function renderPicker(
    candidates: readonly { peerId: string; name: string | null }[],
  ) {
    let tree!: ReactTestRenderer.ReactTestRenderer;
    ReactTestRenderer.act(() => {
      tree = ReactTestRenderer.create(
        <SafeAreaProvider
          initialMetrics={{
            frame: { x: 0, y: 0, width: 390, height: 844 },
            insets: { top: 47, left: 0, right: 0, bottom: 34 },
          }}
        >
          <CallPicker
            candidates={candidates}
            cap={SMALL_GROUP_CALL_MAX_PARTICIPANTS}
            maxHeight={220}
            onCancel={jest.fn()}
            onStart={jest.fn()}
          />
        </SafeAreaProvider>,
      );
    });
    mounted.push(tree);
    return tree;
  }

  const rowsFor = (tree: ReactTestRenderer.ReactTestRenderer, peerId: string) =>
    tree.root.findAll(n => n.props.testID === `call-picker-row-${peerId}`);

  it('renders the placeholder for a candidate it holds no name for', () => {
    // FALSIFYING CASE: render `c.name` raw. An unnamed candidate then arrives
    // as `personName`'s id fragment from App.tsx and paints it, and a row with
    // a null name says nothing at all to VoiceOver.
    const tree = renderPicker([{ peerId: NOBODY, name: null }]);
    const rows = rowsFor(tree, NOBODY);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.props.accessibilityLabel).toBe(UNNAMED);
    expect(renderedText(tree)).toContain(UNNAMED);
    // Nowhere: not on screen, not spoken, not whole and not in fragments.
    const everything = [renderedText(tree), ...labels(tree)].join('\n');
    expect(everything).not.toContain(NOBODY);
    expect(everything).not.toContain(shortId(NOBODY));
    expect(everything).not.toContain('K7CHN9Q');
  });

  it('refuses a name that is really the id, and keeps the real ones', () => {
    // A person whose shared name IS their account id — the echo `tileName`
    // exists for. The named row beside it is what proves the rule is a rule
    // and not a blanket.
    const tree = renderPicker([
      { peerId: SELF_TITLED, name: SELF_TITLED },
      { peerId: NAMED, name: 'Ana' },
    ]);
    for (const row of rowsFor(tree, SELF_TITLED)) {
      expect(row.props.accessibilityLabel).toBe(UNNAMED);
    }
    for (const row of rowsFor(tree, NAMED)) {
      expect(row.props.accessibilityLabel).toBe('Ana');
    }
    const everything = [renderedText(tree), ...labels(tree)].join('\n');
    expect(everything).toContain(UNNAMED);
    expect(everything).toContain('Ana');
    expect(everything).not.toContain(SELF_TITLED);
    expect(everything).not.toContain('X4PVR2T');
  });

  it('refuses the id FRAGMENT a call site may hand it', () => {
    // `personName`'s fallback, arriving as a name. Legitimate in a chat list,
    // forbidden on a call surface — the picker is a call surface.
    const tree = renderPicker([{ peerId: NOBODY, name: shortId(NOBODY) }]);
    for (const row of rowsFor(tree, NOBODY)) {
      expect(row.props.accessibilityLabel).toBe(UNNAMED);
    }
    const everything = [renderedText(tree), ...labels(tree)].join('\n');
    expect(everything).not.toContain('K7CHN9Q');
  });
});

describe('accessibility', () => {
  it('carries each tile’s state in its own label', () => {
    // "A distinction only visible is not a distinction." A tile that reads
    // just "Ana" to VoiceOver has communicated nothing about the call.
    const { tree } = render({
      view: view({ legs: [leg(ANA, 'ringing'), leg(BEN, 'failed')] }),
    });
    const all = labels(tree);
    expect(all).toContain('Ana, ringing');
    expect(all).toContain('Ben, couldn’t connect');
  });

  it('spells a tile label as name-then-state', () => {
    expect(tileAccessibilityLabel('Ana', 'Ringing…')).toBe('Ana, ringing');
    expect(tileAccessibilityLabel('Ben', 'Not called — you blocked them')).toBe(
      'Ben, not called — you blocked them',
    );
  });

  it('announces the mute state as well as showing it', () => {
    const { tree, byLabel } = render({ view: view({ muted: true }) });
    // The control reports it…
    expect(byLabel('Unmute').props.accessibilityState).toEqual({
      selected: true,
      disabled: false,
    });
    // …and it is announced, for the person who cannot see the glyph.
    const banner = tree.root.findByProps({ testID: 'group-call-muted' });
    expect(banner.props.accessibilityLiveRegion).toBe('polite');
  });

  it('lets a tile grow with Dynamic Type instead of clipping', () => {
    // Falsifier: put a fixed height on the tile or on its status line. At
    // Dynamic Type XXL the words that make a tile worth having are the ones
    // that would disappear.
    const { tree } = render({ view: view({ legs: [leg(ANA, 'reconnecting')] }) });
    const tile = tree.root.findByProps({ testID: `group-call-tile-${ANA}` });
    const scaling = tile
      .findAllByType(Text)
      .filter(n => n.props.allowFontScaling !== false);
    expect(scaling.length).toBeGreaterThan(0);
    for (const node of scaling) {
      let cursor: typeof node | null = node;
      while (cursor) {
        const flat = StyleSheet.flatten(cursor.props.style) ?? {};
        expect(flat.height).toBeUndefined();
        expect(flat.maxHeight).toBeUndefined();
        if (cursor === tile) break;
        cursor = cursor.parent as typeof node | null;
      }
    }
  });
});

describe('mute, and the leg it could not silence', () => {
  it('renders mute from the view, never optimistically', () => {
    // THE RULE THIS SCREEN EXISTS TO KEEP. The design closes a leg it cannot silence
    // and only then reports muted; a local optimistic flag would show a muted
    // glyph over a live microphone in exactly the window that matters.
    // Falsifier: hold `useState(view.muted)` and flip it on press.
    let settle!: () => void;
    const onToggleMute = jest.fn(
      () => new Promise<void>(res => { settle = () => res(); }),
    );
    const { tree, byLabel } = render({ onToggleMute });
    ReactTestRenderer.act(() => {
      byLabel('Mute').props.onPress();
    });
    expect(onToggleMute).toHaveBeenCalledTimes(1);
    // The fan-out is still in flight; the view still says unmuted.
    expect(tree.root.findAll(n => n.props.accessibilityLabel === 'Unmute')).toHaveLength(0);
    expect(tree.root.findAll(n => n.props.testID === 'group-call-muted')).toHaveLength(0);
    ReactTestRenderer.act(() => {
      settle();
      pushView?.(view({ muted: true }));
    });
    expect(byLabel('Unmute')).toBeTruthy();
  });

  it('names the person a fan-out dropped, from the fan’s own answer', async () => {
    // The design: a leg that could not be silenced is CLOSED. The person who pressed
    // mute is owed that sentence — otherwise the call quietly got smaller.
    // Falsifier: drop the reporting effect; the notice never appears.
    let settle!: (outcomes: LegFanOutcome[]) => void;
    const onToggleMute = jest.fn(
      () => new Promise<LegFanOutcome[]>(res => { settle = res; }),
    );
    const { tree, byLabel } = render({
      view: view({ legs: [leg(ANA, 'connected'), leg(BEN, 'connected')] }),
      onToggleMute,
    });
    ReactTestRenderer.act(() => {
      byLabel('Mute').props.onPress();
    });
    // Nothing is claimed while the fan is still walking the legs.
    expect(
      tree.root.findAll(n => n.props.testID === 'group-call-fan-failure'),
    ).toHaveLength(0);

    await ReactTestRenderer.act(async () => {
      // The coordinator's all-or-close-the-leg outcome, as data.
      settle([
        { peerId: ANA, cid: ANA_CID, applied: true, closed: false },
        { peerId: BEN, cid: BEN_CID, applied: false, closed: true },
      ]);
      pushView?.(
        view({ legs: [leg(ANA, 'connected'), leg(BEN, 'failed')], muted: true }),
      );
    });
    const notice = tree.root.findByProps({ testID: 'group-call-fan-failure' });
    expect(renderedText(tree)).toContain('Ben was dropped');
    expect(notice.props.accessibilityLiveRegion).toBe('assertive');
  });

  it('says nothing about a leg that failed on its own', () => {
    // A leg that dies while nobody asked for anything is the tile's story, not
    // the control bar's — over-claiming here would be its own kind of lie.
    const { tree } = render({
      view: view({ legs: [leg(ANA, 'connected'), leg(BEN, 'connected')] }),
    });
    ReactTestRenderer.act(() => {
      pushView?.(view({ legs: [leg(ANA, 'connected'), leg(BEN, 'failed')] }));
    });
    expect(
      tree.root.findAll(n => n.props.testID === 'group-call-fan-failure'),
    ).toHaveLength(0);
  });

  it('does not blame the toggle for a leg that died DURING it', async () => {
    // CAUSALITY BY DATA, NOT BY TIME WINDOW. Attribution
    // used to be "whoever left the live set while a toggle promise was
    // outstanding", so an unrelated hangup or an ICE failure landing in that
    // window was reported as "their leg couldn't be changed": a sentence about
    // somebody's microphone that was simply untrue.
    //
    // FALSIFYING CASE, run at authoring time: restore the `fanning`/`settled`
    // refs and the live-set diff. Ben — who hung up on his own, mid-toggle —
    // is then named in the failure notice and this goes red.
    let settle!: (outcomes: LegFanOutcome[]) => void;
    const onToggleMute = jest.fn(
      () => new Promise<LegFanOutcome[]>(res => { settle = res; }),
    );
    const { tree, byLabel } = render({
      view: view({ legs: [leg(ANA, 'connected'), leg(BEN, 'connected')] }),
      onToggleMute,
    });
    ReactTestRenderer.act(() => {
      byLabel('Mute').props.onPress();
    });
    // Ben's leg dies of its own accord while the fan is still in flight.
    ReactTestRenderer.act(() => {
      pushView?.(view({ legs: [leg(ANA, 'connected'), leg(BEN, 'left')] }));
    });
    // The fan itself closed nobody: it silenced the one leg it could reach.
    await ReactTestRenderer.act(async () => {
      settle([{ peerId: ANA, cid: ANA_CID, applied: true, closed: false }]);
      pushView?.(
        view({ legs: [leg(ANA, 'connected'), leg(BEN, 'left')], muted: true }),
      );
    });

    expect(
      tree.root.findAll(n => n.props.testID === 'group-call-fan-failure'),
    ).toHaveLength(0);
    expect(renderedText(tree)).not.toContain('was dropped');
    // Ben's own tile still tells his story, which is where it belongs.
    expect(labels(tree)).toContain('Ben, left');
  });

  it('forgets the last toggle’s casualties when a new one starts', async () => {
    // The notice belongs to ONE press. A latch that outlived its fan is how
    // the old attribution stayed armed until some unrelated later view.
    let settle!: (outcomes: LegFanOutcome[]) => void;
    const onToggleMute = jest.fn(
      () => new Promise<LegFanOutcome[]>(res => { settle = res; }),
    );
    const { tree, byLabel } = render({
      view: view({ legs: [leg(ANA, 'connected'), leg(BEN, 'connected')] }),
      onToggleMute,
    });
    ReactTestRenderer.act(() => {
      byLabel('Mute').props.onPress();
    });
    await ReactTestRenderer.act(async () => {
      settle([{ peerId: BEN, cid: BEN_CID, applied: false, closed: true }]);
      pushView?.(
        view({ legs: [leg(ANA, 'connected'), leg(BEN, 'failed')], muted: true }),
      );
    });
    expect(renderedText(tree)).toContain('Ben was dropped');

    ReactTestRenderer.act(() => {
      byLabel('Unmute').props.onPress();
    });
    expect(
      tree.root.findAll(n => n.props.testID === 'group-call-fan-failure'),
    ).toHaveLength(0);
    await ReactTestRenderer.act(async () => {
      settle([{ peerId: ANA, cid: ANA_CID, applied: true, closed: false }]);
    });
    expect(renderedText(tree)).not.toContain('was dropped');
  });

  it('forgets them when the SESSION is swapped underneath the screen', async () => {
    // A glare swap replaces the session without unmounting this component:
    // App.tsx renders the screen while `groupView` is non-null, so a new sid
    // arrives as a prop change and every piece of screen-owned state survives
    // it. The drop notice is the one that must not: session A's "Ben was
    // dropped" over session B is a sentence about a call Ben may be happily
    // inside.
    //
    // FALSIFYING CASE: clear `dropped` only inside `fan()` — the notice then
    // rides the swap and both assertions below go red.
    let settle!: (outcomes: LegFanOutcome[]) => void;
    const onToggleMute = jest.fn(
      () => new Promise<LegFanOutcome[]>(res => { settle = res; }),
    );
    const { tree, byLabel } = render({
      view: view({ legs: [leg(ANA, 'connected'), leg(BEN, 'connected')] }),
      onToggleMute,
    });
    ReactTestRenderer.act(() => {
      byLabel('Mute').props.onPress();
    });
    await ReactTestRenderer.act(async () => {
      settle([{ peerId: BEN, cid: BEN_CID, applied: false, closed: true }]);
      pushView?.(
        view({ legs: [leg(ANA, 'connected'), leg(BEN, 'failed')], muted: true }),
      );
    });
    expect(renderedText(tree)).toContain('Ben was dropped');

    // The glare: session B, same screen, nobody's fan has run in it yet. A new
    // session is a new `sessionKey` — the coordinator bumps its incarnation on
    // every identity transition, and the sid beside it is only cargo.
    ReactTestRenderer.act(() => {
      pushView?.(
        view({
          sid: SID_B,
          sessionKey: 2,
          roster: [ME, CARA],
          legs: [leg(CARA, 'connected')],
          muted: false,
        }),
      );
    });
    expect(
      tree.root.findAll(n => n.props.testID === 'group-call-fan-failure'),
    ).toHaveLength(0);
    expect(renderedText(tree)).not.toContain('was dropped');
  });

  it('repeats the banner reset when the first session render is abandoned', async () => {
    // A concurrent render owns neither refs nor state until it commits. The
    // old ref mutation survived B's suspended attempt while B's state reset
    // did not, so the retry skipped the only branch that could remove A's
    // casualty banner.
    const wake = deferred();
    let blockB = true;
    let bAttempts = 0;
    let publish!: React.Dispatch<React.SetStateAction<GroupCallView>>;
    let settle!: (outcomes: LegFanOutcome[]) => void;
    const onToggleMute = jest.fn(
      () => new Promise<LegFanOutcome[]>(done => { settle = done; }),
    );

    function Gate({ sessionKey }: { sessionKey: number }) {
      if (sessionKey === 2) {
        bAttempts += 1;
        if (blockB) throw wake.promise;
      }
      return null;
    }

    function ConcurrentHarness() {
      const [current, setCurrent] = useState(
        view({ legs: [leg(ANA, 'connected'), leg(BEN, 'connected')] }),
      );
      publish = setCurrent;
      return (
        <React.Suspense fallback={null}>
          <GroupCallScreen
            view={current}
            nameFor={id => NAMES[id] ?? null}
            onToggleMute={onToggleMute}
            onToggleSpeaker={jest.fn()}
            onEnd={jest.fn()}
            now={() => T}
          />
          <Gate sessionKey={current.sessionKey} />
        </React.Suspense>
      );
    }

    let tree!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(
        <ConcurrentHarness />,
        { unstable_isConcurrent: true } as never,
      );
    });
    mounted.push(tree);
    const byLabel = (label: string) =>
      tree.root.findAll(
        n => n.props.accessibilityLabel === label && typeof n.type !== 'string',
      )[0];

    ReactTestRenderer.act(() => {
      byLabel('Mute').props.onPress();
    });
    await ReactTestRenderer.act(async () => {
      settle([{ peerId: BEN, cid: BEN_CID, applied: false, closed: true }]);
    });
    expect(renderedText(tree)).toContain('Ben was dropped');

    ReactTestRenderer.act(() => {
      React.startTransition(() => {
        publish(
          view({
            sid: SID_B,
            sessionKey: 2,
            roster: [ME, CARA],
            legs: [leg(CARA, 'connected')],
          }),
        );
      });
    });
    expect(bAttempts).toBe(1);
    expect(
      tree.root.findByType(GroupCallScreen).props.view.sessionKey,
    ).toBe(1);

    blockB = false;
    await ReactTestRenderer.act(async () => {
      wake.resolve();
      await wake.promise;
    });

    expect(bAttempts).toBeGreaterThan(1);
    expect(tree.root.findByType(GroupCallScreen).props.view.sessionKey).toBe(2);
    expect(
      tree.root.findAll(n => n.props.testID === 'group-call-fan-failure'),
    ).toHaveLength(0);
    expect(renderedText(tree)).not.toContain('was dropped');
  });

  it('lets no fan report into the session that replaced the one it asked', async () => {
    // The same finding from the other side. The swap can land while a fan is
    // still walking session A's legs; the verdict then arrives with nothing
    // left to attach it to, and a reset that already ran cannot undo it.
    //
    // FALSIFYING CASE: drop the sid check in `fan`'s `.then`. Ben — who was in
    // session A — is named over session B's roster, which does not contain him.
    let settle!: (outcomes: LegFanOutcome[]) => void;
    const onToggleMute = jest.fn(
      () => new Promise<LegFanOutcome[]>(res => { settle = res; }),
    );
    const { tree, byLabel } = render({
      view: view({ legs: [leg(ANA, 'connected'), leg(BEN, 'connected')] }),
      onToggleMute,
    });
    ReactTestRenderer.act(() => {
      byLabel('Mute').props.onPress();
    });
    // Session B arrives before session A's fan has answered.
    ReactTestRenderer.act(() => {
      pushView?.(
        view({
          sid: SID_B,
          sessionKey: 2,
          roster: [ME, CARA],
          legs: [leg(CARA, 'connected')],
        }),
      );
    });
    await ReactTestRenderer.act(async () => {
      settle([{ peerId: BEN, cid: BEN_CID, applied: false, closed: true }]);
    });

    expect(
      tree.root.findAll(n => n.props.testID === 'group-call-fan-failure'),
    ).toHaveLength(0);
    expect(renderedText(tree)).not.toContain('was dropped');
  });

  it('forgets them when the swap wears the SAME sid', async () => {
    // The reset compared `view.sid` — the one identity this
    // codebase's own fence calls forgeable: this device does not mint an
    // inbound session's sid, the remote starter does, so a fresh call can wear
    // a dead one's name (a re-ring, or a replay). The screen is not remounted
    // across a swap — App.tsx renders it unkeyed for as long as there is any
    // session — so under an equal sid nothing reset at all and session A's
    // "Ben was dropped" was published over session B's roster, which does not
    // contain Ben.
    //
    // FALSIFYING CASE, run at authoring time: compare `view.sid` again. The
    // notice rides the swap and both assertions below go red.
    let settle!: (outcomes: LegFanOutcome[]) => void;
    const onToggleMute = jest.fn(
      () => new Promise<LegFanOutcome[]>(res => { settle = res; }),
    );
    const { tree, byLabel } = render({
      view: view({ legs: [leg(ANA, 'connected'), leg(BEN, 'connected')] }),
      onToggleMute,
    });
    ReactTestRenderer.act(() => {
      byLabel('Mute').props.onPress();
    });
    await ReactTestRenderer.act(async () => {
      settle([{ peerId: BEN, cid: BEN_CID, applied: false, closed: true }]);
      pushView?.(
        view({ legs: [leg(ANA, 'connected'), leg(BEN, 'failed')], muted: true }),
      );
    });
    expect(renderedText(tree)).toContain('Ben was dropped');

    // The swap: a DIFFERENT session under an IDENTICAL sid. Only the
    // coordinator's session key says so, which is the whole point of
    // publishing it.
    ReactTestRenderer.act(() => {
      pushView?.(
        view({
          sid: SID,
          sessionKey: 2,
          roster: [ME, CARA],
          legs: [leg(CARA, 'connected')],
          muted: false,
        }),
      );
    });
    expect(
      tree.root.findAll(n => n.props.testID === 'group-call-fan-failure'),
    ).toHaveLength(0);
    expect(renderedText(tree)).not.toContain('was dropped');
  });

  it('lets a slow fan overwrite nothing a NEWER fan already painted', async () => {
    // The late-report guard ordered SESSIONS and not PRESSES: two
    // fans in one session both pass the session check, so the older one's
    // verdict — arriving second because it was slower — overwrote the newer
    // one's casualties. That contradicts this component's own rule that a new
    // fan forgets the last fan's dead, and it publishes a name the person's
    // most recent press has nothing to do with.
    //
    // FALSIFYING CASE, run at authoring time: drop the `fanSeq` check in
    // `fan`'s `.then`. Ben — session A's MUTE casualty — replaces Cara, whom
    // the camera fan actually dropped, and both assertions below go red.
    let settleMute!: (outcomes: LegFanOutcome[]) => void;
    let settleCamera!: (outcomes: LegFanOutcome[]) => void;
    const onToggleMute = jest.fn(
      () => new Promise<LegFanOutcome[]>(res => { settleMute = res; }),
    );
    const onToggleCamera = jest.fn(
      () => new Promise<LegFanOutcome[]>(res => { settleCamera = res; }),
    );
    const { tree, byLabel } = render({
      view: view({
        video: true,
        roster: [ME, ANA, BEN, CARA],
        legs: [leg(ANA, 'connected'), leg(BEN, 'connected'), leg(CARA, 'connected')],
      }),
      onToggleMute,
      onToggleCamera,
    });

    // A slow mute fan, then a camera fan on top of it.
    ReactTestRenderer.act(() => {
      byLabel('Mute').props.onPress();
    });
    ReactTestRenderer.act(() => {
      byLabel('Turn camera on').props.onPress();
    });

    // The camera fan answers FIRST and paints its own casualty.
    await ReactTestRenderer.act(async () => {
      settleCamera([{ peerId: CARA, cid: CARA_CID, applied: false, closed: true }]);
    });
    expect(renderedText(tree)).toContain('Cara was dropped');

    // …and the older mute fan, finishing afterwards, may not speak over it.
    await ReactTestRenderer.act(async () => {
      settleMute([{ peerId: BEN, cid: BEN_CID, applied: false, closed: true }]);
    });
    expect(renderedText(tree)).toContain('Cara was dropped');
    expect(renderedText(tree)).not.toContain('Ben was dropped');
  });

  it('names nobody when a failed apply closed nothing', async () => {
    // THE NO-OP CLOSE, AS THE PERSON MEETS IT. The coordinator's fan can fail to
    // apply a change to a cid the peer has already abandoned — they re-offered
    // mid-fan — and its `closeLeg` is then correctly a no-op. The outcome says
    // so now (`applied: false, closed: false`), and this is the sentence that
    // must not appear: Ben is in the call, on a newer leg, muted.
    //
    // FALSIFYING CASE: report the fan's INTENT again (`closed: true`) and Ben —
    // whose tile below says `connecting` — is named in the drop notice.
    let settle!: (outcomes: LegFanOutcome[]) => void;
    const onToggleMute = jest.fn(
      () => new Promise<LegFanOutcome[]>(res => { settle = res; }),
    );
    const { tree, byLabel } = render({
      view: view({ legs: [leg(ANA, 'connected'), leg(BEN, 'connected')] }),
      onToggleMute,
    });
    ReactTestRenderer.act(() => {
      byLabel('Mute').props.onPress();
    });
    await ReactTestRenderer.act(async () => {
      settle([
        { peerId: ANA, cid: ANA_CID, applied: true, closed: false },
        { peerId: BEN, cid: BEN_CID, applied: false, closed: false },
      ]);
      pushView?.(
        view({ legs: [leg(ANA, 'connected'), leg(BEN, 'connecting')], muted: true }),
      );
    });

    expect(
      tree.root.findAll(n => n.props.testID === 'group-call-fan-failure'),
    ).toHaveLength(0);
    expect(renderedText(tree)).not.toContain('was dropped');
    // Ben is on screen and still in the call, which is the whole point.
    expect(labels(tree)).toContain('Ben, connecting');
  });

  it('shows the closed leg’s own state on its tile', () => {
    const { tree } = render({
      view: view({ legs: [leg(ANA, 'connected'), leg(BEN, 'failed')], muted: true }),
    });
    expect(labels(tree)).toContain('Ben, couldn’t connect');
  });
});

describe('the loudspeaker', () => {
  it('is offered in every live group call, between mute and Add', () => {
    // GROUP CALLS SHIP AUDIO ONLY ("v1 scope, cut to the launch
    // date"), which makes this control the difference between a five-person
    // call and holding the phone against your ear for it. The camera button
    // beside it is video-gated and therefore unreachable in v1; this one must
    // never be, so the assertion is made on an AUDIO session.
    //
    // FALSIFYING CASE, run at authoring time: gate the button on `view.video`
    // the way the camera is. It disappears from the audio session below and
    // this goes red.
    // `onAdd` is supplied so the third control exists to be ordered against;
    // the speaker's own presence is asserted on the audio session regardless.
    const { tree, byLabel } = render({
      view: view({ video: false, starterId: ME, selfId: ME }),
      onAdd: jest.fn(),
    });
    expect(
      tree.root.findAll(n => n.props.testID === 'group-call-speaker').length,
    ).toBeGreaterThan(0);
    // The 1:1 screen's words exactly — it is the same control, and two names
    // for one act is two things to learn.
    expect(byLabel('Speaker on')).toBeTruthy();

    // ORDER, because a control's position is part of how it is found: mute,
    // speaker, then Add. Consecutive duplicates are collapsed — one
    // `ControlButton` puts its testID on several nodes of its own tree, and
    // that is a fact about the component rather than about the layout.
    const wanted = ['group-call-mute', 'group-call-speaker', 'group-call-add'];
    const order: string[] = [];
    for (const node of tree.root.findAll(n => wanted.includes(n.props.testID))) {
      const id = node.props.testID as string;
      if (order[order.length - 1] !== id) order.push(id);
    }
    expect(order).toEqual(wanted);
  });

  it('presses through to the caller, once', () => {
    // FALSIFYING CASE: drop `onPress`. The handler is never called and this
    // goes red — a control that renders and does nothing is worse than none.
    const onToggleSpeaker = jest.fn();
    const { byLabel } = render({ onToggleSpeaker });
    ReactTestRenderer.act(() => {
      byLabel('Speaker on').props.onPress();
    });
    expect(onToggleSpeaker).toHaveBeenCalledTimes(1);
  });

  it('renders its state from the view, and says so to VoiceOver', () => {
    // FROM THE VIEW, like mute: the coordinator writes `speakerOn` only after
    // the bridge call it made resolves, so this cannot light over a route the
    // device did not take.
    //
    // FALSIFYING CASE, run at authoring time: hold the state in a local
    // `useState` and flip it on press. The press below lights the button while
    // the bridge call is still in flight, and the first two assertions after
    // the press go red.
    let settle!: () => void;
    const onToggleSpeaker = jest.fn(() => {
      void new Promise<void>(res => { settle = () => res(); });
    });
    const { tree, byLabel } = render({ onToggleSpeaker });
    expect(byLabel('Speaker on').props.accessibilityState).toEqual({
      selected: false,
      disabled: false,
    });

    ReactTestRenderer.act(() => {
      byLabel('Speaker on').props.onPress();
    });
    // The route change is still in flight; nothing claims it happened.
    expect(tree.root.findAll(n => n.props.accessibilityLabel === 'Speaker off')).toHaveLength(0);

    ReactTestRenderer.act(() => {
      settle?.();
      pushView?.(view({ speakerOn: true }));
    });
    expect(byLabel('Speaker off')).toBeTruthy();
    expect(byLabel('Speaker off').props.accessibilityState).toEqual({
      selected: true,
      disabled: false,
    });
  });

  it('does not clear the "was dropped" banner a mute earned', async () => {
    // THE REASON IT IS NOT ROUTED THROUGH `fan()`. The speaker fans nothing —
    // one device, one output route — so it drops nobody and has no outcomes to
    // report. Passing it through the fan helper would reset `dropped` on a
    // press that closed no leg, erasing a sentence about somebody's call that
    // the person is still owed and has not acknowledged.
    //
    // FALSIFYING CASE, run at authoring time: change the press to
    // `fan(onToggleSpeaker)`. The banner disappears and this goes red.
    let settle!: (outcomes: LegFanOutcome[]) => void;
    const onToggleMute = jest.fn(
      () => new Promise<LegFanOutcome[]>(res => { settle = res; }),
    );
    const { tree, byLabel } = render({
      view: view({ legs: [leg(ANA, 'connected'), leg(BEN, 'connected')] }),
      onToggleMute,
    });
    ReactTestRenderer.act(() => {
      byLabel('Mute').props.onPress();
    });
    await ReactTestRenderer.act(async () => {
      settle([{ peerId: BEN, cid: BEN_CID, applied: false, closed: true }]);
      pushView?.(
        view({ legs: [leg(ANA, 'connected'), leg(BEN, 'failed')], muted: true }),
      );
    });
    expect(renderedText(tree)).toContain('Ben was dropped');

    ReactTestRenderer.act(() => {
      byLabel('Speaker on').props.onPress();
    });
    expect(
      tree.root.findAll(n => n.props.testID === 'group-call-fan-failure').length,
    ).toBeGreaterThan(0);
    expect(renderedText(tree)).toContain('Ben was dropped');
  });

  it('is absent while the session is still ringing here', () => {
    // Rule 25, the same reason mute is absent: nothing is open yet, so there
    // is no route to choose and no call to route.
    const { tree } = render({
      view: view({ phase: 'ringing', starterId: ANA, connectedAt: null }),
      onAnswer: jest.fn(),
      onDecline: jest.fn(),
    });
    expect(tree.root.findAll(n => n.props.testID === 'group-call-speaker')).toHaveLength(0);
  });
});

describe('the cap', () => {
  it('states the picker copy verbatim, and the number matches the ceiling', () => {
    // String equality on purpose: a copy edit here must be a conscious act.
    expect(CALL_CAP_COPY).toBe('Calls hold six people. For more, use the room.');
    // And the number is not free-floating. It used to say five — a
    // deliberate under-promise from when video capped a call at five — which
    // stopped being safe the moment group video was cut and six became the
    // only ceiling: Add stayed live for a sixth person while the sentence
    // said five. Pinning the copy to the constant is what stops the two
    // drifting apart again in either direction.
    // The sentence spells the number, so the pin has to as well — comparing
    // against the digit passes vacuously on any copy that happens to contain
    // a "6" and fails on the real one.
    const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven'];
    expect(CALL_CAP_COPY).toContain(WORDS[SMALL_GROUP_CALL_MAX_PARTICIPANTS]);
  });

  it('disables Add at the AUDIO ceiling, not before it', () => {
    // The falsifying case is a hard-coded 5: an audio call holds six, and a
    // screen that minted its own number would disable a seat too early.
    const full = [ME, ANA, BEN, CARA, DEE, EVE];
    expect(full).toHaveLength(SMALL_GROUP_CALL_MAX_PARTICIPANTS);
    const under = render({
      view: view({ video: false, roster: full.slice(0, -1), legs: [] }),
      onAdd: jest.fn(),
    });
    expect(under.byLabel('Add someone').props.accessibilityState.disabled).toBe(false);

    const at = render({
      view: view({ video: false, roster: full, legs: [] }),
      onAdd: jest.fn(),
    });
    const add = at.byLabel('Add someone');
    expect(add.props.accessibilityState.disabled).toBe(true);
    expect(add.props.accessibilityHint).toBe(CALL_CAP_COPY);
    expect(renderedText(at.tree)).toContain(CALL_CAP_COPY);
  });

  it('disables Add one seat earlier with video', () => {
    const roster = [ME, ANA, BEN, CARA, DEE];
    expect(roster).toHaveLength(SMALL_GROUP_CALL_MAX_VIDEO_PARTICIPANTS);
    const at = render({
      view: view({ video: true, roster, legs: [] }),
      onAdd: jest.fn(),
    });
    expect(at.byLabel('Add someone').props.accessibilityState.disabled).toBe(true);
    // The same roster in an AUDIO session still has a seat left, which is
    // what proves the split is real rather than one number wearing two names.
    const audio = render({
      view: view({ video: false, roster, legs: [] }),
      onAdd: jest.fn(),
    });
    expect(audio.byLabel('Add someone').props.accessibilityState.disabled).toBe(false);
  });

  it('offers Add to the starter only', () => {
    const notStarter = render({
      view: view({ starterId: ANA, selfId: ME }),
      onAdd: jest.fn(),
    });
    expect(
      notStarter.tree.root.findAll(n => n.props.testID === 'group-call-add'),
    ).toHaveLength(0);
    const starter = render({ view: view({ starterId: ME, selfId: ME }), onAdd: jest.fn() });
    expect(starter.byLabel('Add someone')).toBeTruthy();
  });
});

describe('layout and copy', () => {
  it('collapses to the 1:1 layout at two people and grows from there', () => {
    // The degradation is literally this: a session down to two participants
    // is the 1:1 screen again, one tile wide.
    expect(gridColumns(2)).toBe(1);
    expect(gridRows(2)).toBe(1);
    expect(gridColumns(3)).toBe(2);
    expect(gridRows(3)).toBe(1);
    expect(gridColumns(4)).toBe(2);
    expect(gridRows(4)).toBe(2);
    expect(gridColumns(6)).toBe(2);
    expect(gridRows(6)).toBe(3);
  });

  it('names who the call is with, from local names only', () => {
    expect(rosterSubtitle(['Ana'])).toBe('Ana');
    expect(rosterSubtitle(['Ana', 'Ben'])).toBe('Ana and Ben');
    expect(rosterSubtitle(['Ana', 'Ben', 'Cara'])).toBe('Ana and 2 others');
  });

  it('folds the legs into one session status', () => {
    expect(sessionStatusLabel(view({ legs: [leg(ANA, 'connected'), leg(BEN, 'ringing')] }))).toBe(
      'Connected',
    );
    expect(sessionStatusLabel(view({ legs: [leg(ANA, 'inviting'), leg(BEN, 'inviting')] }))).toBe(
      'Calling…',
    );
    expect(
      sessionStatusLabel(view({ legs: [leg(ANA, 'reconnecting'), leg(BEN, 'ringing')] })),
    ).toBe('Reconnecting…');
    expect(sessionStatusLabel(view({ phase: 'ringing' }))).toBe('Incoming call');
    expect(sessionStatusLabel(view({ legs: [leg(ANA, 'left'), leg(BEN, 'gone')] }))).toBe(
      'Ending…',
    );
  });

  it('calls the red button what it actually does', () => {
    // A non-starter LEAVES; only the starter ends it for everyone.
    const starter = render({ view: view({ starterId: ME, selfId: ME }) });
    expect(starter.byLabel('End call')).toBeTruthy();
    const guest = render({ view: view({ starterId: ANA, selfId: ME }) });
    expect(guest.byLabel('Leave call')).toBeTruthy();
  });

  it('offers answer and decline while the session is ringing here', () => {
    const { tree, byLabel } = render({
      view: view({ phase: 'ringing', starterId: ANA, connectedAt: null }),
      onAnswer: jest.fn(),
      onDecline: jest.fn(),
    });
    expect(byLabel('Answer')).toBeTruthy();
    expect(byLabel('Decline')).toBeTruthy();
    // No mute button before the call is answered: there is nothing to mute,
    // and rule 25 keeps media closed until a human says yes.
    expect(tree.root.findAll(n => n.props.testID === 'group-call-mute')).toHaveLength(0);
  });

  it('offers no camera control in an audio session', () => {
    const audio = render({ view: view({ video: false }), onToggleCamera: jest.fn() });
    expect(
      audio.tree.root.findAll(n => n.props.testID === 'group-call-camera'),
    ).toHaveLength(0);
    const video = render({ view: view({ video: true }), onToggleCamera: jest.fn() });
    expect(video.byLabel('Turn camera on')).toBeTruthy();
  });

  it('renders one tile per roster member but itself', () => {
    const { tree } = render({
      view: view({
        roster: [ME, ANA, BEN, CARA],
        legs: [leg(ANA, 'connected'), leg(BEN, 'ringing'), leg(CARA, 'inviting')],
      }),
    });
    const grid = tree.root.findByProps({ testID: 'group-call-grid' });
    const tiles = new Set(
      grid
        .findAll(
          n =>
            typeof n.props.testID === 'string' &&
            n.props.testID.startsWith('group-call-tile-'),
        )
        .map(n => String(n.props.testID)),
    );
    expect(tiles.size).toBe(3);
    expect(tree.root.findAll(n => n.props.testID === `group-call-tile-${ME}`)).toHaveLength(0);
  });

  it('stays on the media surface — no cream, no new colour', () => {
    const { tree } = render();
    const root = tree.root.findByProps({ accessibilityLabel: 'Group call' });
    const flat = StyleSheet.flatten(root.props.style) as { backgroundColor?: string };
    // The one dark surface this app has (theme.ts `mediaBlack`), the same one
    // CallScreen and the photo viewer use.
    expect(flat.backgroundColor).toBe('#060807');
  });
});

function describeAppOwnedStateAcrossCoordinatorSessions() {
  describe('App-owned state across coordinator sessions', () => {
    it('never commits A camera or picker state in B\'s first frame', async () => {
      // These two booleans live in App, not GroupCallScreen, and App keeps the
      // overlay mounted for as long as any group session exists. Resetting
      // them in a passive effect lets A's camera choice and open picker COMMIT
      // once over B before the effect gets a turn.
      //
      // FALSIFYING CASE: move the reset back into the old `useEffect`. The
      // Profiler snapshot below reads camera off and picker open on B's first
      // frame even though the settled tree looks right.
      jest.useRealTimers();
      let current: GroupCallView | null = view({
        roomId: ROOM,
        video: true,
        roster: [ME, ANA],
        legs: [leg(ANA, 'connected')],
      });
      const subscribers = new Set<
        React.Dispatch<React.SetStateAction<GroupCallView | null>>
      >();
      const hook = jest
        .spyOn(calling, 'useGroupCallState')
        .mockImplementation(() => {
          const [published, setPublished] = React.useState(current);
          React.useEffect(() => {
            subscribers.add(setPublished);
            return () => {
              subscribers.delete(setPublished);
            };
          }, []);
          return published;
        });
      const fakeCoordinator = {
        setVideoEnabled: jest.fn(async () => []),
        addParticipant: jest.fn(async () => undefined),
        hangup: jest.fn(async () => undefined),
      } as unknown as ReturnType<typeof calling.groupCall>;
      const coordinator = jest
        .spyOn(calling, 'groupCall')
        .mockReturnValue(fakeCoordinator);
      const names = jest.spyOn(db, 'listChats').mockResolvedValue([]);
      const group = jest.spyOn(db, 'getGroup').mockResolvedValue({
        groupId: ROOM,
        ownerId: ME,
        name: 'Kitchen',
      });
      const chat = jest.spyOn(db, 'getChat').mockResolvedValue(null);
      const slots = jest.spyOn(db, 'listGroupMemberSlots').mockResolvedValue([
        { memberId: ME, writerId: ME, seq: 1, state: 'in' },
        { memberId: ANA, writerId: ME, seq: 2, state: 'in' },
        { memberId: CARA, writerId: ME, seq: 3, state: 'in' },
      ]);
      let tree: ReactTestRenderer.ReactTestRenderer | null = null;
      let firstBFrame: {
        cameraOn: boolean;
        pickerOpen: boolean;
        caraPicked: boolean;
      } | null = null;
      const captureFrame = () => {
        if (!tree || firstBFrame) return;
        const screen = tree.root.findAllByType(GroupCallScreen)[0];
        if (screen?.props.view.sessionKey !== 2) return;
        const pickerOpen =
          tree.root.findAll(n => n.props.testID === 'call-picker').length > 0;
        const caraPicked = tree.root
          .findAll(n => n.props.testID === `call-picker-row-${CARA}`)
          .some(n => n.props.accessibilityState?.checked === true);
        firstBFrame = {
          cameraOn: screen.props.cameraOn === true,
          pickerOpen,
          caraPicked,
        };
      };

      try {
        await ReactTestRenderer.act(async () => {
          tree = ReactTestRenderer.create(
            <React.Profiler id="group-session-frame" onRender={captureFrame}>
              <App />
            </React.Profiler>,
          );
        });
        await ReactTestRenderer.act(async () => {});

        const byLabel = (label: string) =>
          tree!.root.findAll(
            n =>
              n.props.accessibilityLabel === label &&
              typeof n.type !== 'string',
          )[0];

        // Session A began with video. The person turns it off, then opens Add.
        expect(byLabel('Turn camera off')).toBeTruthy();
        await ReactTestRenderer.act(async () => {
          await byLabel('Turn camera off').props.onPress();
        });
        expect(byLabel('Turn camera on')).toBeTruthy();
        ReactTestRenderer.act(() => {
          byLabel('Add someone').props.onPress();
        });
        await ReactTestRenderer.act(async () => {});
        expect(
          tree!.root.findAll(n => n.props.testID === 'call-picker').length,
        ).toBeGreaterThan(0);
        ReactTestRenderer.act(() => {
          tree!.root.findByProps({ testID: `call-picker-row-${CARA}` }).props.onPress();
        });
        expect(
          tree!.root.findByProps({ testID: `call-picker-row-${CARA}` }).props
            .accessibilityState.checked,
        ).toBe(true);
        const nameReadsBeforeSwap = names.mock.calls.length;

        // B is a different coordinator incarnation with identical protocol
        // cargo. Only `sessionKey` can make the render-time reset run.
        await ReactTestRenderer.act(async () => {
          current = view({
            sid: SID,
            sessionKey: 2,
            roomId: ROOM,
            video: true,
            roster: [ME, ANA],
            legs: [leg(ANA, 'connected')],
          });
          for (const publish of subscribers) publish(current);
        });

        // Profiler fires for the commit before passive effects. A test that
        // reads only the settled tree cannot see the stale frame this guards.
        expect(firstBFrame).toEqual({
          cameraOn: true,
          pickerOpen: false,
          caraPicked: false,
        });

        const cameraLabel = byLabel('Turn camera off')
          ? 'Turn camera off'
          : 'Turn camera on';
        expect({
          cameraLabel,
          pickerOpen:
            tree!.root.findAll(n => n.props.testID === 'call-picker').length >
            0,
          namesReloaded: names.mock.calls.length > nameReadsBeforeSwap,
        }).toEqual({
          cameraLabel: 'Turn camera off',
          pickerOpen: false,
          namesReloaded: true,
        });

        // The ordinary B path still opens Add, and its picker begins with no
        // private selection inherited from A's dead component instance.
        ReactTestRenderer.act(() => {
          byLabel('Add someone').props.onPress();
        });
        await ReactTestRenderer.act(async () => {});
        expect(
          tree!.root.findByProps({ testID: `call-picker-row-${CARA}` }).props
            .accessibilityState.checked,
        ).toBe(false);
      } finally {
        if (tree) {
          await ReactTestRenderer.act(async () => {
            tree!.unmount();
          });
        }
        hook.mockRestore();
        coordinator.mockRestore();
        names.mockRestore();
        group.mockRestore();
        chat.mockRestore();
        slots.mockRestore();
        await db.close();
      }
    });

    it('repeats App camera and picker resets after an abandoned render', async () => {
      // The reset has to live in React state with the values it owns. A ref
      // written by B's first attempt survived suspension, while B's camera and
      // picker updates were discarded with that work-in-progress tree.
      jest.useRealTimers();
      const wake = deferred();
      let blockB = true;
      let bAttempts = 0;
      let current: GroupCallView | null = view({
        roomId: ROOM,
        video: true,
        roster: [ME, ANA],
        legs: [leg(ANA, 'connected')],
      });
      const subscribers = new Set<
        React.Dispatch<React.SetStateAction<GroupCallView | null>>
      >();
      const hook = jest
        .spyOn(calling, 'useGroupCallState')
        .mockImplementation(() => {
          const [published, setPublished] = React.useState(current);
          React.useEffect(() => {
            subscribers.add(setPublished);
            return () => {
              subscribers.delete(setPublished);
            };
          }, []);
          return published;
        });
      const fakeCoordinator = {
        setVideoEnabled: jest.fn(async () => []),
        addParticipant: jest.fn(async () => undefined),
        hangup: jest.fn(async () => undefined),
      } as unknown as ReturnType<typeof calling.groupCall>;
      const coordinator = jest
        .spyOn(calling, 'groupCall')
        .mockReturnValue(fakeCoordinator);
      const names = jest.spyOn(db, 'listChats').mockResolvedValue([]);
      const group = jest.spyOn(db, 'getGroup').mockResolvedValue({
        groupId: ROOM,
        ownerId: ME,
        name: 'Kitchen',
      });
      const chat = jest.spyOn(db, 'getChat').mockResolvedValue(null);
      const slots = jest.spyOn(db, 'listGroupMemberSlots').mockResolvedValue([
        { memberId: ME, writerId: ME, seq: 1, state: 'in' },
        { memberId: ANA, writerId: ME, seq: 2, state: 'in' },
        { memberId: CARA, writerId: ME, seq: 3, state: 'in' },
      ]);
      const screenModule = jest.requireActual(
        '../src/screens/GroupCallScreen',
      ) as typeof import('../src/screens/GroupCallScreen');
      const RealGroupCallScreen = screenModule.GroupCallScreen;
      const screen = jest
        .spyOn(screenModule, 'GroupCallScreen')
        .mockImplementation(props => {
          if (props.view.sessionKey === 2) {
            bAttempts += 1;
            if (blockB) throw wake.promise;
          }
          return <RealGroupCallScreen {...props} />;
        });
      let tree: ReactTestRenderer.ReactTestRenderer | null = null;

      try {
        await ReactTestRenderer.act(async () => {
          tree = ReactTestRenderer.create(
            <React.Suspense fallback={null}>
              <App />
            </React.Suspense>,
            { unstable_isConcurrent: true } as never,
          );
        });
        await ReactTestRenderer.act(async () => {});

        const byLabel = (label: string) =>
          tree!.root.findAll(
            n =>
              n.props.accessibilityLabel === label &&
              typeof n.type !== 'string',
          )[0];

        expect(byLabel('Turn camera off')).toBeTruthy();
        await ReactTestRenderer.act(async () => {
          await byLabel('Turn camera off').props.onPress();
        });
        expect(byLabel('Turn camera on')).toBeTruthy();
        ReactTestRenderer.act(() => {
          byLabel('Add someone').props.onPress();
        });
        await ReactTestRenderer.act(async () => {});
        expect(
          tree!.root.findAll(n => n.props.testID === 'call-picker').length,
        ).toBeGreaterThan(0);

        ReactTestRenderer.act(() => {
          current = view({
            sid: SID,
            sessionKey: 2,
            roomId: ROOM,
            video: true,
            roster: [ME, ANA],
            legs: [leg(ANA, 'connected')],
          });
          React.startTransition(() => {
            for (const publish of subscribers) publish(current);
          });
        });
        expect(bAttempts).toBe(1);
        expect(
          tree!.root.findAllByType(RealGroupCallScreen)[0].props.view.sessionKey,
        ).toBe(1);

        blockB = false;
        await ReactTestRenderer.act(async () => {
          wake.resolve();
          await wake.promise;
        });

        const bScreen = tree!.root.findAllByType(RealGroupCallScreen)[0];
        expect(bAttempts).toBeGreaterThan(1);
        expect(bScreen.props.view.sessionKey).toBe(2);
        expect(bScreen.props.cameraOn).toBe(true);
        expect(byLabel('Turn camera off')).toBeTruthy();
        expect(
          tree!.root.findAll(n => n.props.testID === 'call-picker'),
        ).toHaveLength(0);
      } finally {
        if (tree) {
          await ReactTestRenderer.act(async () => {
            tree!.unmount();
          });
        }
        screen.mockRestore();
        hook.mockRestore();
        coordinator.mockRestore();
        names.mockRestore();
        group.mockRestore();
        chat.mockRestore();
        slots.mockRestore();
        await db.close();
      }
    });

    it('wires the speaker button to the speaker, not to some other toggle', async () => {
      // THE LAST SEAM, and the one a required prop cannot check. TypeScript
      // proves App.tsx passes SOMETHING for `onToggleSpeaker`; only a press
      // through the real tree proves it passes the audio route rather than the
      // mute it sits beside.
      //
      // FALSIFYING CASE, run at authoring time: point the prop at
      // `toggleGroupMute`. `toggleGroupSpeaker` is never called and this goes
      // red while every other test in this file still passes.
      jest.useRealTimers();
      const current: GroupCallView | null = view({
        roomId: null,
        roster: [ME, ANA],
        legs: [leg(ANA, 'connected')],
      });
      const hook = jest
        .spyOn(calling, 'useGroupCallState')
        .mockImplementation(() => current);
      const speaker = jest
        .spyOn(calling, 'toggleGroupSpeaker')
        .mockResolvedValue(undefined);
      const mute = jest.spyOn(calling, 'toggleGroupMute').mockResolvedValue([]);
      const fakeCoordinator = {
        setSpeakerEnabled: jest.fn(async () => undefined),
        hangup: jest.fn(async () => undefined),
      } as unknown as ReturnType<typeof calling.groupCall>;
      const coordinator = jest
        .spyOn(calling, 'groupCall')
        .mockReturnValue(fakeCoordinator);
      const names = jest.spyOn(db, 'listChats').mockResolvedValue([]);
      let tree: ReactTestRenderer.ReactTestRenderer | null = null;
      try {
        await ReactTestRenderer.act(async () => {
          tree = ReactTestRenderer.create(<App />);
        });
        await ReactTestRenderer.act(async () => {});
        const byLabel = (label: string) =>
          tree!.root.findAll(
            n => n.props.accessibilityLabel === label && typeof n.type !== 'string',
          )[0];

        expect(byLabel('Speaker on')).toBeTruthy();
        await ReactTestRenderer.act(async () => {
          byLabel('Speaker on')!.props.onPress();
        });

        expect(speaker).toHaveBeenCalledTimes(1);
        // …and it did NOT press the button next door.
        expect(mute).not.toHaveBeenCalled();
      } finally {
        if (tree) {
          await ReactTestRenderer.act(async () => {
            tree!.unmount();
          });
        }
        hook.mockRestore();
        speaker.mockRestore();
        mute.mockRestore();
        coordinator.mockRestore();
        names.mockRestore();
        await db.close();
      }
    });

    it('hands the tile the picture App resolved from chats.avatarB64', async () => {
      // THE ROOM ARM OF THE DARK RECTANGLE, END TO END. `avatarFor` is
      // optional on the screen, so every screen-level test above injects it
      // itself — which is exactly how the prop shipped unadopted: App.tsx
      // passed only `nameFor`, every room-call tile on hardware still drew a
      // monogram over the photo the thread beside it was showing, and 29
      // green tests never noticed. Only a render of the real App proves the
      // wiring exists.
      //
      // FALSIFYING CASE, run at authoring time: delete the `avatarFor` prop
      // where App.tsx renders GroupCallScreen. Ana's tile falls back to the
      // monogram and this goes red while every screen-level test stays green.
      jest.useRealTimers();
      const PHOTO = '/9j/4AAQSkZJRgABAQAAAQABAAD==';
      const current: GroupCallView | null = view({
        roomId: null,
        roster: [ME, ANA, BEN],
        legs: [leg(ANA, 'connected'), leg(BEN, 'connected')],
      });
      const hook = jest
        .spyOn(calling, 'useGroupCallState')
        .mockImplementation(() => current);
      const fakeCoordinator = {
        hangup: jest.fn(async () => undefined),
      } as unknown as ReturnType<typeof calling.groupCall>;
      const coordinator = jest
        .spyOn(calling, 'groupCall')
        .mockReturnValue(fakeCoordinator);
      // The SAME listChats read that names the tiles: Ana shared a photo,
      // Ben did not. One read, both facts — the chat's column, not a second
      // source (the rule `callPeerAvatar` already keeps for the 1:1 arm).
      const names = jest.spyOn(db, 'listChats').mockResolvedValue([
        { peerId: ANA, displayName: 'Ana', localName: null, avatarB64: PHOTO },
        { peerId: BEN, displayName: 'Ben', localName: null, avatarB64: null },
      ] as unknown as Awaited<ReturnType<typeof db.listChats>>);
      let tree: ReactTestRenderer.ReactTestRenderer | null = null;
      try {
        await ReactTestRenderer.act(async () => {
          tree = ReactTestRenderer.create(<App />);
        });
        await ReactTestRenderer.act(async () => {});

        const anaTile = tree!.root.findAll(
          n => n.props.testID === `group-call-tile-${ANA}`,
        )[0]!;
        expect(anaTile).toBeTruthy();
        const anaFaces = anaTile.findAllByType(Avatar);
        expect(anaFaces).toHaveLength(1);
        expect(anaFaces[0]!.props.photoB64).toBe(PHOTO);
        // Ben shared none, so his tile keeps the placeholder: the picture
        // is per-person, not a treatment App switches on for the whole grid.
        const benTile = tree!.root.findAll(
          n => n.props.testID === `group-call-tile-${BEN}`,
        )[0]!;
        expect(benTile.findAllByType(Avatar)).toHaveLength(0);
      } finally {
        if (tree) {
          await ReactTestRenderer.act(async () => {
            tree!.unmount();
          });
        }
        hook.mockRestore();
        coordinator.mockRestore();
        names.mockRestore();
        await db.close();
      }
    });

    async function withRoomTransition(
      bReadable: boolean,
      check: (
        tree: ReactTestRenderer.ReactTestRenderer,
        byLabel: (label: string) => ReactTestRenderer.ReactTestInstance | undefined,
      ) => void | Promise<void>,
    ) {
      jest.useRealTimers();
      let current: GroupCallView | null = view({
        roomId: ROOM,
        roster: [ME, ANA],
        legs: [leg(ANA, 'connected')],
      });
      const subscribers = new Set<
        React.Dispatch<React.SetStateAction<GroupCallView | null>>
      >();
      const hook = jest
        .spyOn(calling, 'useGroupCallState')
        .mockImplementation(() => {
          const [published, setPublished] = React.useState(current);
          React.useEffect(() => {
            subscribers.add(setPublished);
            return () => {
              subscribers.delete(setPublished);
            };
          }, []);
          return published;
        });
      const fakeCoordinator = {
        setVideoEnabled: jest.fn(async () => []),
        addParticipant: jest.fn(async () => undefined),
        hangup: jest.fn(async () => undefined),
      } as unknown as ReturnType<typeof calling.groupCall>;
      const coordinator = jest
        .spyOn(calling, 'groupCall')
        .mockReturnValue(fakeCoordinator);
      const names = jest.spyOn(db, 'listChats').mockResolvedValue([]);
      const group = jest.spyOn(db, 'getGroup').mockImplementation(async roomId => {
        if (roomId === ROOM_B) {
          if (!bReadable) throw new Error('room B unavailable');
          return { groupId: ROOM_B, ownerId: ME, name: 'Studio' };
        }
        return { groupId: ROOM, ownerId: ME, name: 'Kitchen' };
      });
      const chat = jest.spyOn(db, 'getChat').mockImplementation(async roomId => ({
        peerId: roomId,
        localName: roomId === ROOM_B ? 'Studio' : 'Kitchen',
      } as Awaited<ReturnType<typeof db.getChat>>));
      const slots = jest
        .spyOn(db, 'listGroupMemberSlots')
        .mockImplementation(async roomId =>
          roomId === ROOM_B
            ? [
                { memberId: ME, writerId: ME, seq: 1, state: 'in' as const },
                { memberId: BEN, writerId: ME, seq: 2, state: 'in' as const },
                { memberId: DEE, writerId: ME, seq: 3, state: 'in' as const },
              ]
            : [
                { memberId: ME, writerId: ME, seq: 1, state: 'in' as const },
                { memberId: ANA, writerId: ME, seq: 2, state: 'in' as const },
                { memberId: CARA, writerId: ME, seq: 3, state: 'in' as const },
              ],
        );
      let tree: ReactTestRenderer.ReactTestRenderer | null = null;

      try {
        await ReactTestRenderer.act(async () => {
          tree = ReactTestRenderer.create(<App />);
        });
        await ReactTestRenderer.act(async () => {});
        const byLabel = (label: string) =>
          tree!.root.findAll(
            n =>
              n.props.accessibilityLabel === label &&
              typeof n.type !== 'string',
          )[0];
        expect(byLabel('Add someone')).toBeTruthy();

        await ReactTestRenderer.act(async () => {
          current = view({
            sid: SID_B,
            sessionKey: 2,
            roomId: ROOM_B,
            roster: [ME, BEN],
            legs: [leg(BEN, 'connected')],
          });
          for (const publish of subscribers) publish(current);
        });
        await ReactTestRenderer.act(async () => {});

        await check(tree!, byLabel);
      } finally {
        if (tree) {
          await ReactTestRenderer.act(async () => {
            tree!.unmount();
          });
        }
        hook.mockRestore();
        coordinator.mockRestore();
        names.mockRestore();
        group.mockRestore();
        chat.mockRestore();
        slots.mockRestore();
        await db.close();
      }
    }

    it('shows no room A candidates after room B replaces it and cannot be read', async () => {
      await withRoomTransition(false, async (tree, byLabel) => {
        // `addParticipant` still re-folds at dial time and protects the
        // boundary. This assertion protects the screen from displaying A's
        // names while B's own fold is unavailable.
        const add = byLabel('Add someone');
        if (add) {
          ReactTestRenderer.act(() => {
            add.props.onPress();
          });
          await ReactTestRenderer.act(async () => {});
        }
        expect(
          tree.root.findAll(n => n.props.testID === `call-picker-row-${CARA}`),
        ).toHaveLength(0);
        expect(add).toBeUndefined();
      });
    });

    it('loads and offers only room B candidates after a room transition', async () => {
      await withRoomTransition(true, async (tree, byLabel) => {
        expect(byLabel('Add someone')).toBeTruthy();
        ReactTestRenderer.act(() => {
          byLabel('Add someone')!.props.onPress();
        });
        await ReactTestRenderer.act(async () => {});
        expect(
          tree.root.findAll(n => n.props.testID === `call-picker-row-${DEE}`),
        ).not.toHaveLength(0);
        expect(
          tree.root.findAll(n => n.props.testID === `call-picker-row-${CARA}`),
        ).toHaveLength(0);
      });
    });
  });
}

/**
 * THE MINIMIZED CALL IS 1:1-ONLY ("go back to
 * the chat while the video call is on"). The small-group screen offers no
 * minimize control and no prop to wire one: its ring-answer path lives on
 * this screen (`onAnswer`/`onDecline`), its Add picker is a second App-level
 * overlay tied to it, and a leg has no cid for a video window to show (mesh
 * video comes later). A group window is a recorded follow-up — an audio pill of
 * roster count and duration — not a silent half of this train.
 */
describe('minimize is not offered here (1:1-only)', () => {
  it('renders no minimize control in any phase', () => {
    for (const phase of ['live', 'ringing'] as const) {
      const { tree, byLabel } = render({
        view: view({ phase }),
        ...(phase === 'ringing' ? { onAnswer: jest.fn(), onDecline: jest.fn() } : {}),
      });
      expect(byLabel('Minimize call')).toBeUndefined();
      expect(tree.root.findAll(n => n.props.testID === 'call-minimize')).toHaveLength(0);
    }
  });

  it('has no onMinimize prop to wire — the type does not carry one', () => {
    const props: GroupCallScreenProps = {
      view: view(),
      nameFor: () => null,
      onToggleMute: () => {},
      onToggleSpeaker: () => {},
      onEnd: () => {},
    };
    expect('onMinimize' in props).toBe(false);
  });
});

// A tile is a View, not a host string; keep the import honest.
void View;

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});
