/**
 * The member-consent surface in the room roster. What these pin:
 *
 *  - the surface appears ONLY when the room contains an agent this phone can
 *    name AND that this account does NOT own, and it offers each such agent a
 *    share / don't-share decision;
 *  - the CHOICE is offered only for a MARKER-detected agent this account does
 *    NOT own: `listRoomAgentAuthorIds` (it has sent an AI-marked message here)
 *    MINUS `machine_peers` (the machines this phone paired). A SECOND human,
 *    whose record never names someone else's agent, is the party the feature
 *    is for. This account's OWN agent is admitted by the owner clause
 *    unconditionally and needs no edge, so it is NEVER offered a choice — a
 *    share would burn a cap slot on a row no predicate reads, a hold would
 *    announce a stance the delivery never honours. `machine_peers` still feeds
 *    row attribution/badges, just not the offer;
 *  - a decision drives `messaging.setRoomConsent(groupId, agent, share)` — the
 *    one method that writes the edge, records locally, and announces;
 *  - the cap note is surfaced from the method's `atCap`, which comes from
 *    LOCAL count alone (never a server probe);
 *  - the current state governs which actions show (undecided → both;
 *    consented → only "Don't share"; refused → only "Share").
 *
 * Harness follows GroupProfile.agent.test.tsx.
 */

import React from 'react';
import { Text } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import * as db from '../src/db';
import { messaging } from '../src/messaging';
import { AI_DISCLOSURE_SENTENCE } from '../src/machine';
import {
  GroupProfileScreen,
  ROOM_COPY,
} from '../src/screens/GroupProfileScreen';

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
const ROOM = ulid('R00MCNST');
const ME = ulid('ME1');
const CLAUDE = ulid('AGENT'); // the agent member
const T0 = new Date('2026-08-14T09:00:00').getTime();

const ME_PROFILE: db.ProfileRow = {
  userId: ME,
  registrationId: 7,
  displayName: 'Nat',
  about: '',
  avatarB64: '',
  profileVersion: 1,
};

const chatRow = (peerId: string, displayName: string) => ({
  peerId,
  displayName,
  localName: null,
  about: null,
  avatarB64: null,
  profileVersion: null,
  lastMessageAt: T0,
  lastMessageText: '',
  safetyCheckedAt: null,
  createdAt: T0,
  lastOpenedAt: null,
  identityChangedAt: null,
  safetyMismatchAt: null,
});

/** `machines` — the machine_peers record; `markerAuthors` — DISTINCT authors
 * of ai-marked messages here; `consent` — this user's stored decision per
 * agent. The DEFAULT is the party the surface is FOR: a second human who
 * detected CLAUDE by its MARKER alone (machines empty) — so the choice is
 * offered. The owner's-own-agent case (machines=[CLAUDE]) is set explicitly
 * where it is tested, because for it the choice must be ABSENT. */
function installDb(
  opts: {
    machines?: string[];
    markerAuthors?: string[];
    consent?: Record<string, 'consented' | 'refused'>;
    /** The room's owner — ME by default; a FOREIGN owner makes this phone the
     * second human's (the stranger's), the party the consent surface is FOR. */
    ownerId?: string;
    /** Member ids the OWNER's roster slots class 'integration' (the
     * roster-write class). */
    rosterAgents?: string[];
    /** The foreign owner's stored display name ('Ana' by default) — settable
     * so a peer self-named "You" can be shown not to forge the self signal. */
    ownerName?: string;
  } = {},
) {
  const machines = opts.machines ?? [];
  const markerAuthors = opts.markerAuthors ?? [CLAUDE];
  const consent = opts.consent ?? {};
  const ownerId = opts.ownerId ?? ME;
  const rosterAgents = new Set(opts.rosterAgents ?? []);
  const ownerName = opts.ownerName ?? 'Ana';
  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(
    async (sql: string, params?: unknown[]) => {
      const s = String(sql);
      if (s.includes('FROM machine_peers')) {
        return { rows: machines.map(peerId => ({ peerId })) };
      }
      if (s.includes('DISTINCT authorId FROM messages')) {
        return { rows: markerAuthors.map(authorId => ({ authorId })) };
      }
      if (s.includes('FROM agent_consent')) {
        const state = consent[String(params?.[0])];
        return { rows: state ? [{ state }] : [] };
      }
      if (s.includes('SELECT groupId, ownerId, name FROM groups')) {
        return params?.[0] === ROOM
          ? { rows: [{ groupId: ROOM, ownerId, name: 'Crew' }] }
          : { rows: [] };
      }
      if (s.includes('FROM group_members')) {
        return params?.[0] === ROOM
          ? {
              rows: [ME, CLAUDE]
                .filter(id => id !== ownerId)
                .concat([ownerId])
                .map(memberId => ({
                  memberId,
                  writerId: ownerId,
                  seq: 1,
                  state: 'in',
                  class: rosterAgents.has(memberId) ? 'integration' : null,
                })),
            }
          : { rows: [] };
      }
      if (s.includes('FROM chats') && s.includes('ORDER BY')) {
        return {
          rows: [
            chatRow(CLAUDE, 'Claude · laptop'),
            ...(ownerId === ME ? [] : [chatRow(ownerId, ownerName)]),
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

async function mount(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <GroupProfileScreen
        groupId={ROOM}
        me={ME_PROFILE}
        onBack={jest.fn()}
        onOpenMember={jest.fn()}
      />,
    );
  });
  await ReactTestRenderer.act(async () => {});
  return tree;
}

let setRoomConsent: jest.SpyInstance;

beforeEach(async () => {
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
  jest
    .spyOn(messaging, 'getSafetyNumber')
    .mockResolvedValue('1234567890'.repeat(6));
  setRoomConsent = jest
    .spyOn(messaging, 'setRoomConsent')
    .mockResolvedValue({ atCap: false, announced: true });
  installDb();
});

afterEach(async () => {
  jest.restoreAllMocks();
  await db.close();
});

test('member consent: the owner is offered NO choice about their OWN agent — the surface is absent', async () => {
  // CLAUDE is in machine_peers: this account's own agent. The owner clause
  // admits it unconditionally, so a share/don't-share offer here would
  // be a lie — the edge no predicate reads, the hold the delivery ignores.
  // With markers empty too, there is no non-owned agent, so the whole surface
  // must be absent. (Revert the choice predicate and this goes red: the owned
  // agent reappears in the offer.)
  installDb({ machines: [CLAUDE], markerAuthors: [] });
  const tree = await mount();
  expect(
    tree.root.findAllByProps({ testID: 'room-consent-section' }).length,
  ).toBe(0);
  expect(
    tree.root.findAllByProps({ testID: `consent-share-${CLAUDE}` }).length,
  ).toBe(0);
  expect(
    tree.root.findAllByProps({ testID: `consent-stop-${CLAUDE}` }).length,
  ).toBe(0);
});

test('member consent: a NON-owned marker-detected agent IS offered both choices when undecided', async () => {
  // The second-human case: CLAUDE is marker-detected here but NOT this
  // account's machine. This is the party the feature is for.
  installDb({ machines: [], markerAuthors: [CLAUDE] });
  const tree = await mount();
  expect(
    tree.root.findAllByProps({ testID: 'room-consent-section' }).length,
  ).toBeGreaterThan(0);
  expect(
    tree.root.findAllByProps({ testID: `consent-share-${CLAUDE}` }).length,
  ).toBeGreaterThan(0);
  expect(
    tree.root.findAllByProps({ testID: `consent-stop-${CLAUDE}` }).length,
  ).toBeGreaterThan(0);
});

test('member consent: an agent this account BOTH owns and has seen speak is still NOT offered — ownership wins', async () => {
  // The common real case that a bare "drop the disjunct" would miss: the
  // owner's own agent HAS spoken here, so it is marker-detected — but it is
  // still owned, so the choice must stay absent. `!machines` is what guarantees
  // that; reverting to the OR predicate makes the owned agent reappear (red).
  installDb({ machines: [CLAUDE], markerAuthors: [CLAUDE] });
  const tree = await mount();
  expect(
    tree.root.findAllByProps({ testID: 'room-consent-section' }).length,
  ).toBe(0);
});

test('no agent, no surface — the section never appears in an agent-free room', async () => {
  installDb({ machines: [], markerAuthors: [] });
  const tree = await mount();
  expect(
    tree.root.findAllByProps({ testID: 'room-consent-section' }).length,
  ).toBe(0);
});

test('a SECOND human detects the agent by its MARKER alone (machine_peers empty) and is offered the choice', async () => {
  // The party the feature is FOR: they never paired the agent, so their
  // machine_peers is empty — but it has spoken an ai-marked message here.
  installDb({ machines: [], markerAuthors: [CLAUDE] });
  const tree = await mount();
  expect(
    tree.root.findAllByProps({ testID: `consent-share-${CLAUDE}` }).length,
  ).toBeGreaterThan(0);
});

test('choosing "Share" drives setRoomConsent(groupId, agent, true)', async () => {
  const tree = await mount();
  const share = tree.root.findByProps({ testID: `consent-share-${CLAUDE}` });
  await ReactTestRenderer.act(async () => {
    share.props.onPress();
  });
  expect(setRoomConsent).toHaveBeenCalledWith(ROOM, CLAUDE, true);
});

test('choosing "Don’t share" drives setRoomConsent(groupId, agent, false)', async () => {
  const tree = await mount();
  const stop = tree.root.findByProps({ testID: `consent-stop-${CLAUDE}` });
  await ReactTestRenderer.act(async () => {
    stop.props.onPress();
  });
  expect(setRoomConsent).toHaveBeenCalledWith(ROOM, CLAUDE, false);
});

test('the cap note surfaces ONLY from the method’s atCap — never from a server probe', async () => {
  setRoomConsent.mockResolvedValue({ atCap: true, announced: true });
  const tree = await mount();
  const share = tree.root.findByProps({ testID: `consent-share-${CLAUDE}` });
  await ReactTestRenderer.act(async () => {
    share.props.onPress();
  });
  await ReactTestRenderer.act(async () => {});
  const note = tree.root.findByProps({ testID: 'room-consent-note' });
  const text = String(
    Array.isArray(note.props.children)
      ? (note.props.children as unknown[]).join('')
      : note.props.children,
  );
  expect(text).toBe(ROOM_COPY.consentCap);
});

test('a consented agent shows only "Don’t share"; a refused one only "Share"', async () => {
  installDb({ consent: { [CLAUDE]: 'consented' } });
  const consented = await mount();
  expect(
    consented.root.findAllByProps({ testID: `consent-stop-${CLAUDE}` }).length,
  ).toBeGreaterThan(0);
  expect(
    consented.root.findAllByProps({ testID: `consent-share-${CLAUDE}` }).length,
  ).toBe(0);

  installDb({ consent: { [CLAUDE]: 'refused' } });
  const refused = await mount();
  expect(
    refused.root.findAllByProps({ testID: `consent-share-${CLAUDE}` }).length,
  ).toBeGreaterThan(0);
  expect(
    refused.root.findAllByProps({ testID: `consent-stop-${CLAUDE}` }).length,
  ).toBe(0);
});

/** Tap Share and read whatever advisory note the row surfaced (or null). */
async function shareAndReadNote(
  tree: ReactTestRenderer.ReactTestRenderer,
): Promise<string | null> {
  const share = tree.root.findByProps({ testID: `consent-share-${CLAUDE}` });
  await ReactTestRenderer.act(async () => {
    share.props.onPress();
  });
  await ReactTestRenderer.act(async () => {});
  const notes = tree.root.findAllByProps({ testID: 'room-consent-note' });
  if (notes.length === 0) return null;
  const { children } = notes[0]!.props as { children: unknown };
  return String(Array.isArray(children) ? children.join('') : children);
}

/** Tap Don’t share and read the resulting advisory note (or null). */
async function stopAndReadNote(
  tree: ReactTestRenderer.ReactTestRenderer,
): Promise<string | null> {
  const stop = tree.root.findByProps({ testID: `consent-stop-${CLAUDE}` });
  await ReactTestRenderer.act(async () => {
    stop.props.onPress();
  });
  await ReactTestRenderer.act(async () => {});
  const notes = tree.root.findAllByProps({ testID: 'room-consent-note' });
  if (notes.length === 0) return null;
  const { children } = notes[0]!.props as { children: unknown };
  return String(Array.isArray(children) ? children.join('') : children);
}

test('m5(a): an edge that stood but a room that could not be told surfaces consentNotAnnounced — never "failed"', async () => {
  // The honest read-only / blocked-member fork: the edge took and
  // this iPhone recorded it, only the announcement leg did not send. Saying
  // "couldn't do that" would be a lie — it DID happen here. Reverting the
  // `!announced` branch drops this note (red).
  setRoomConsent.mockResolvedValue({ atCap: false, announced: false });
  const tree = await mount();
  expect(await shareAndReadNote(tree)).toBe(ROOM_COPY.consentNotAnnounced);
});

test('m5(b): a thrown setRoomConsent — the ONE real failure, the edge did not take — surfaces the generic failed copy', async () => {
  // A throw means the EDGE itself was refused (the delivery-gating act), so the
  // decision did not take at all. Reverting the catch drops this note (red).
  setRoomConsent.mockRejectedValue(new Error('edge refused'));
  const tree = await mount();
  expect(await shareAndReadNote(tree)).toBe(ROOM_COPY.failed);
});

test.each(['consented', 'undecided'] as const)(
  'a failed DELETE leaves %s state unchanged and never claims sharing or an announcement',
  async initial => {
    installDb(
      initial === 'consented' ? { consent: { [CLAUDE]: 'consented' } } : {},
    );
    setRoomConsent.mockRejectedValue(new Error('delete refused'));
    const tree = await mount();
    const note = await stopAndReadNote(tree);

    expect(note).toBe(
      'That sharing change didn’t take. Nothing changed or was announced. Try again.',
    );
    expect(note).not.toMatch(/room was told|still sharing/i);
    expect(
      tree.root.findByProps({ testID: `consent-state-${CLAUDE}` }).props
        .children,
    ).toBe(
      initial === 'consented'
        ? ROOM_COPY.consentShared
        : ROOM_COPY.consentUndecided,
    );
  },
);

test('DELETE success plus announcement failure says sharing stopped but the room was not told', async () => {
  const consent: Record<string, 'consented' | 'refused'> = {
    [CLAUDE]: 'consented',
  };
  installDb({ consent });
  setRoomConsent.mockImplementation(async () => {
    consent[CLAUDE] = 'refused';
    return { atCap: false, announced: false };
  });
  const tree = await mount();

  expect(await stopAndReadNote(tree)).toBe(
    'Sharing stopped, but the people in the room couldn’t be told. Try again so they see it.',
  );
  expect(
    tree.root.findByProps({ testID: `consent-state-${CLAUDE}` }).props.children,
  ).toBe(ROOM_COPY.consentRefused);
});

test('a successful DELETE and announcement show no error note', async () => {
  installDb({ consent: { [CLAUDE]: 'consented' } });
  const tree = await mount();

  expect(await stopAndReadNote(tree)).toBeNull();
});

/**
 * THE BOOTSTRAP DEADLOCK, INVERTED. A runtime
 * test proved this exact state on a real stranger's device: three unanswered
 * @mentions, zero ai rows (the server correctly refuses the agent's
 * pre-consent frames), no machine record — and the Sharing section ABSENT,
 * so the consent that would fix it could never be offered. The owner's
 * roster write now carries the class, and the surface appears the moment the
 * stranger opens the room, BEFORE the agent has ever spoken.
 */
const OWNER_ANA = ulid('ANA');

test('THE DEADLOCK TEST: a stranger with a CLASS-carrying roster and ZERO ai rows IS offered the choice', async () => {
  installDb({
    ownerId: OWNER_ANA,
    machines: [],
    markerAuthors: [], // the agent has NEVER been heard — the deadlock state
    rosterAgents: [CLAUDE],
  });
  const tree = await mount();
  expect(
    tree.root.findAllByProps({ testID: 'room-consent-section' }).length,
  ).toBeGreaterThan(0);
  expect(
    tree.root.findAllByProps({ testID: `consent-share-${CLAUDE}` }).length,
  ).toBeGreaterThan(0);
  expect(
    tree.root.findAllByProps({ testID: `consent-stop-${CLAUDE}` }).length,
  ).toBeGreaterThan(0);
});

test('a roster-classed agent this account OWNS is still never offered — ownership outranks class', async () => {
  installDb({
    ownerId: ME,
    machines: [CLAUDE],
    markerAuthors: [],
    rosterAgents: [CLAUDE],
  });
  const tree = await mount();
  expect(
    tree.root.findAllByProps({ testID: 'room-consent-section' }).length,
  ).toBe(0);
});

/** All Text content inside one consent row, joined. */
function consentRowText(tree: ReactTestRenderer.ReactTestRenderer): string {
  const row = tree.root.findByProps({ testID: `consent-${CLAUDE}` });
  return row
    .findAllByType(Text)
    .map(n => {
      const { children } = n.props as { children: unknown };
      return Array.isArray(children)
        ? (children as unknown[]).join('')
        : String(children ?? '');
    })
    .join('\n');
}

test('the consent row names the agent WITH the owner attribution — never an anonymous ULID', async () => {
  installDb({
    ownerId: OWNER_ANA,
    machines: [],
    markerAuthors: [],
    rosterAgents: [CLAUDE],
  });
  const tree = await mount();
  const text = consentRowText(tree);
  expect(text).toContain('Claude · laptop');
  expect(text).toContain('AI agent');
  expect(text).toContain('Ana');
});

test('m3(b): a MARKER-only agent is NOT attributed to the room owner — the owner claimed nothing', async () => {
  // CLAUDE is in the set because IT sent a marker-carrying body; Ana's roster write
  // carries no class. "Ana's AI agent" would put a claim in Ana's mouth she
  // never made — the copy must say where the label actually came from: the
  // agent's own marked speech.
  installDb({
    ownerId: OWNER_ANA,
    machines: [],
    markerAuthors: [CLAUDE],
    rosterAgents: [],
  });
  const tree = await mount();
  const text = consentRowText(tree);
  expect(text).toContain('Claude · laptop');
  expect(text).toContain('self-labeled');
  expect(text).not.toContain('Ana');
});

test('m3(a): an OWNER-viewer with a marker-only agent never reads "You’s AI agent"', async () => {
  // The viewer owns the room; the agent is marker-detected but never adopted
  // (machine_peers empty — machine.ts's paired-never-adopted state). nameFor
  // returns the literal 'You' for self, and the possessive template would
  // render "You’s AI agent". Marker-only also means neutral copy here — this
  // owner's roster claimed nothing either.
  installDb({
    ownerId: ME,
    machines: [],
    markerAuthors: [CLAUDE],
    rosterAgents: [],
  });
  const tree = await mount();
  const text = consentRowText(tree);
  expect(text).not.toContain('You’s');
  expect(text).toContain('self-labeled');
});

test('m3(a): a foreign owner display-named "You" cannot forge the self signal in the possessive', async () => {
  // ChatThreadScreen's nameFor rule, applied here: a peer whose displayName
  // is literally "You" would otherwise render "You’s AI agent" on every
  // co-member's phone. The short id takes the slot instead.
  installDb({
    ownerId: OWNER_ANA,
    machines: [],
    markerAuthors: [],
    rosterAgents: [CLAUDE],
    ownerName: 'You',
  });
  const tree = await mount();
  const text = consentRowText(tree);
  expect(text).not.toContain('You’s');
  expect(text).toContain('AI agent');
});

/**
 * THE DISCLOSURE AT THE CONSENT MOMENT (Apple 5.1.2(i)). The
 * disclosure table was written before this
 * consent UI existed and named only the adopt flow — but a NON-OWNER human
 * never adopts anything. Their permission-first moment is this one: the
 * instant they choose to let an agent hear them. The sentence therefore has
 * to be on screen before "Share" can be pressed, and it has to be the
 * constant, not a room-flavoured re-write of it.
 */
test('5.1.2(i): the canonical sentence is on screen BEFORE consent can be given', async () => {
  const tree = await mount();
  const said = tree.root.findByProps({ testID: 'room-consent-disclosure' });
  const text = said
    .findAllByType(Text)
    .map(n => String((n.props as { children: unknown }).children ?? ''))
    .join('');
  expect(text).toBe(AI_DISCLOSURE_SENTENCE);
  // Nothing has been consented to at the moment the sentence is readable —
  // the Share action is still un-pressed and the edge unwritten.
  expect(setRoomConsent).not.toHaveBeenCalled();
  expect(
    tree.root.findAllByProps({ testID: `consent-share-${CLAUDE}` }).length,
  ).toBeGreaterThan(0);
});

test('the room surface QUOTES the constant — no per-surface variant', () => {
  // `toBe` alone would pass vacuously with both sides undefined; pin one
  // load-bearing fragment so the absence of the copy is a failure too.
  expect(ROOM_COPY.consentDisclosure).toContain(
    'relay ciphertext only.',
  );
  expect(ROOM_COPY.consentDisclosure).toBe(AI_DISCLOSURE_SENTENCE);
});
