/**
 * The machine section (crew-chat): adopt into crew / revoke, server-answered.
 *
 * The section exists on EVERY peer profile because the app cannot know which
 * contacts are its machines — the server refuses to enumerate a crew even to
 * its owner, and these tests pin the consequences: the server's answer is
 * what the screen reports, the collapsed refusal stays collapsed, nothing
 * fires without a confirm step, and the network-failure sentence is the same
 * one a duress session's transport guard produces.
 *
 * Harness follows PeerProfile.blocking.test.tsx (fake op-sqlite from
 * jest.setup.js); the api layer is cut at its own seam by mocking ../src/api
 * — the section's contract is "report what the server said", so the test
 * scripts the server.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { StyleSheet, Text } from 'react-native';
import * as db from '../src/db';
import {
  AI_DISCLOSURE_SENTENCE,
  MACHINE_COPY as MACHINE,
  machineFailureCopy,
} from '../src/machine';
import { PeerProfileScreen } from '../src/screens/PeerProfileScreen';
import { themeTokens } from '../src/theme';

jest.mock('../src/api', () => {
  const actual = jest.requireActual('../src/api');
  return {
    ...actual,
    apiCrewAdopt: jest.fn(),
    apiIntegrationRevoke: jest.fn(),
  };
});
jest.mock('../src/reauth', () => ({
  ...jest.requireActual('../src/reauth'),
  currentToken: jest.fn(async () => 'tok-owner'),
}));

import { ApiRequestError, apiCrewAdopt, apiIntegrationRevoke } from '../src/api';

const adoptMock = apiCrewAdopt as jest.Mock;
const revokeMock = apiIntegrationRevoke as jest.Mock;

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

const T0 = new Date('2026-07-31T09:00:00').getTime();
const PEER = '01MACHZ3NDEKTSV4RRFFQ69G5F';

const ME: db.ProfileRow = {
  userId: '01KYDBSSDJSPC9J0E5N2AWMJ5Y',
  registrationId: 7,
  displayName: 'Nat',
  about: '',
  avatarB64: '',
  profileVersion: 1,
};

const CHAT = {
  peerId: PEER,
  displayName: 'Claude · laptop',
  lastMessageAt: T0,
  lastMessageText: 'agent finished',
  about: null,
  avatarB64: null,
  profileVersion: null,
  safetyCheckedAt: null,
  localName: null,
  createdAt: T0,
  lastOpenedAt: null,
  identityChangedAt: null,
  safetyMismatchAt: null,
};

beforeEach(async () => {
  jest.clearAllMocks();
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(async (sql: string, params?: unknown) => {
    const s = String(sql);
    if (s.includes('FROM blocked_peers')) return { rows: [] };
    if (s.includes('FROM chats')) return { rows: [CHAT] };
    return base(s, params);
  });
});

async function mount() {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <PeerProfileScreen peerId={PEER} me={ME} onBack={() => {}} />,
    );
  });
  return tree;
}

function byId(tree: ReactTestRenderer.ReactTestRenderer, id: string) {
  return tree.root.findByProps({ testID: id });
}
function textOf(tree: ReactTestRenderer.ReactTestRenderer, id: string): string {
  return byId(tree, id)
    .findAllByType(Text)
    .map(n => n.props.children)
    .flat()
    .join('');
}
async function press(tree: ReactTestRenderer.ReactTestRenderer, id: string) {
  await ReactTestRenderer.act(async () => {
    byId(tree, id).props.onPress();
  });
}

describe('the machine section, server-answered', () => {
  it('adopt fires ONLY through the confirm step, with the owner bearer and this peer', async () => {
    adoptMock.mockResolvedValueOnce(undefined);
    const tree = await mount();
    await press(tree, 'peer-machine-adopt');
    // Confirm step shown, nothing sent yet.
    expect(adoptMock).not.toHaveBeenCalled();
    await press(tree, 'peer-machine-adopt-confirm');
    expect(adoptMock).toHaveBeenCalledWith('tok-owner', PEER);
    expect(textOf(tree, 'peer-machine-ok')).toBe(MACHINE.adopted);
    // A confirmation is charcoal text; forest marks an action.
    expect(StyleSheet.flatten(byId(tree, 'peer-machine-ok').props.style).color).toBe(
      themeTokens().color.inkBody,
    );
  });

  it('cancel is a real exit: no call, no note', async () => {
    const tree = await mount();
    await press(tree, 'peer-machine-adopt');
    await press(tree, 'peer-machine-cancel');
    expect(adoptMock).not.toHaveBeenCalled();
    expect(tree.root.findAllByProps({ testID: 'peer-machine-ok' })).toHaveLength(0);
    expect(tree.root.findAllByProps({ testID: 'peer-machine-error' })).toHaveLength(0);
  });

  it('the collapsed refusal stays collapsed on screen, exactly one sentence', async () => {
    adoptMock.mockRejectedValueOnce(
      new ApiRequestError('server prose the screen must not need', 403, 'not_integration_owner'),
    );
    const tree = await mount();
    await press(tree, 'peer-machine-adopt');
    await press(tree, 'peer-machine-adopt-confirm');
    const err = textOf(tree, 'peer-machine-error');
    expect(err).toBe('Not a machine you paired — nothing changed.');
    expect(err).not.toContain('server prose');
  });

  it('revoke goes through its own confirm and reports the retirement', async () => {
    revokeMock.mockResolvedValueOnce(undefined);
    const tree = await mount();
    await press(tree, 'peer-machine-revoke');
    expect(revokeMock).not.toHaveBeenCalled();
    await press(tree, 'peer-machine-revoke-confirm');
    expect(revokeMock).toHaveBeenCalledWith('tok-owner', PEER);
    expect(textOf(tree, 'peer-machine-ok')).toBe(MACHINE.revoked);
  });

  it('a network throw reads as offline — the duress cover sentence, and the outcome stays OPEN', async () => {
    adoptMock.mockRejectedValueOnce(new TypeError('Network request failed'));
    const tree = await mount();
    await press(tree, 'peer-machine-adopt');
    await press(tree, 'peer-machine-adopt-confirm');
    expect(textOf(tree, 'peer-machine-error')).toBe(
      'Couldn’t reach the server — this may not have gone through. Trying again is safe.',
    );
  });
});

describe('the machine record: the server’s positive answers are remembered, its refusals are not', () => {
  const inserts = () => {
    const instance = sqlite.instances.get('tacendum.sqlite')!;
    return instance.execute.mock.calls.filter(([sql]: [string]) =>
      String(sql).includes('INSERT INTO machine_peers'),
    );
  };
  const revokedInserts = () => {
    const instance = sqlite.instances.get('tacendum.sqlite')!;
    return instance.execute.mock.calls.filter(([sql]: [string]) =>
      String(sql).includes('INSERT INTO revoked_machine_peers'),
    );
  };
  const approvalPurges = () => {
    const instance = sqlite.instances.get('tacendum.sqlite')!;
    return instance.execute.mock.calls.filter(([sql]: [string]) =>
      String(sql).includes('DELETE FROM approvals WHERE peerId'),
    );
  };

  it('adopt success records this peer as a machine — the one moment the app KNOWS', async () => {
    adoptMock.mockResolvedValueOnce(undefined);
    const tree = await mount();
    await press(tree, 'peer-machine-adopt');
    expect(inserts()).toHaveLength(0); // confirming is not knowing
    await press(tree, 'peer-machine-adopt-confirm');
    const calls = inserts();
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toEqual(expect.arrayContaining([PEER]));
  });

  it('a refusal records NOTHING — the collapsed answer stays collapsed locally too', async () => {
    adoptMock.mockRejectedValueOnce(
      new ApiRequestError('detail', 403, 'not_integration_owner'),
    );
    const tree = await mount();
    await press(tree, 'peer-machine-adopt');
    await press(tree, 'peer-machine-adopt-confirm');
    expect(inserts()).toHaveLength(0);
  });

  it('revoke success records too — the 204 is the same oracle answer, and a retired machine’s history keeps its marker', async () => {
    revokeMock.mockResolvedValueOnce(undefined);
    const tree = await mount();
    await press(tree, 'peer-machine-revoke');
    await press(tree, 'peer-machine-revoke-confirm');
    const calls = inserts();
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toEqual(expect.arrayContaining([PEER]));
    expect(revokedInserts()).toHaveLength(1);
    expect(revokedInserts()[0]![1]).toEqual(expect.arrayContaining([PEER]));
    expect(approvalPurges()).toHaveLength(1);
  });

  it('a failed revoke writes neither lifecycle history nor an approval purge', async () => {
    revokeMock.mockRejectedValueOnce(new TypeError('Network request failed'));
    const tree = await mount();
    await press(tree, 'peer-machine-revoke');
    await press(tree, 'peer-machine-revoke-confirm');
    expect(revokedInserts()).toHaveLength(0);
    expect(approvalPurges()).toHaveLength(0);
  });

  it('the record is append-once at rest and in the sign-out wipe', async () => {
    // ON CONFLICT DO NOTHING: the first learn wins; re-learning changes
    // nothing (a class is never re-acquired, mirroring the server's rule).
    await db.recordMachinePeer(PEER, T0);
    const instance = sqlite.instances.get('tacendum.sqlite')!;
    const [sql] = instance.execute.mock.calls.find(([q]: [string]) =>
      String(q).includes('INSERT INTO machine_peers'),
    )!;
    expect(String(sql)).toContain('DO NOTHING');
    // Wiped on sign-out with everything else: the decoy workspace must never
    // inherit which contacts are the real account's machines.
    expect(db.DB_TABLES).toContain('machine_peers');
    expect(db.DB_TABLES).toContain('revoked_machine_peers');
  });

  it('listMachinePeers returns the recorded ids', async () => {
    const instance = sqlite.instances.get('tacendum.sqlite')!;
    const base = instance.execute.getMockImplementation()!;
    instance.execute.mockImplementation(async (sql: string, params?: unknown) => {
      if (String(sql).includes('FROM machine_peers')) {
        return { rows: [{ peerId: PEER }] };
      }
      return base(sql, params);
    });
    await expect(db.listMachinePeers()).resolves.toEqual([PEER]);
  });
});

describe('the disclosure at the adopt moment (Apple 5.1.2(i) permission-first)', () => {
  it('says plainly that what is adopted here is an AI agent', async () => {
    const tree = await mount();
    const said = textOf(tree, 'peer-machine-ai');
    expect(said).toBe(MACHINE.agentIsAI);
    expect(said).toContain('AI agent');
  });

  it('the canonical sentence is on screen BEFORE the confirm step — and still there AT it', async () => {
    // "Permission first" is a placement claim, not a copy claim: disclosure
    // that only appears after the 204 is disclosure after the fact. So it is
    // pinned in BOTH states the section has, with the adopt call proven
    // un-fired in between.
    adoptMock.mockResolvedValueOnce(undefined);
    const tree = await mount();
    expect(textOf(tree, 'peer-machine-disclosure')).toBe(AI_DISCLOSURE_SENTENCE);
    await press(tree, 'peer-machine-adopt');
    expect(adoptMock).not.toHaveBeenCalled();
    expect(textOf(tree, 'peer-machine-disclosure')).toBe(AI_DISCLOSURE_SENTENCE);
  });

  it('the teaching detail sits behind the ⓘ, not in the section body', async () => {
    // The ⓘ's testID rides a Pressable INSIDE InfoDisclosure, so the file's
    // `press` (which takes the first node wearing the id — here the composite)
    // does not reach it; find the node that actually handles the press.
    const openInfo = async (tree: ReactTestRenderer.ReactTestRenderer) => {
      const node = tree.root.findAll(
        n => n.props?.testID === 'peer-machine-info' && typeof n.props?.onPress === 'function',
      )[0]!;
      await ReactTestRenderer.act(async () => node.props.onPress());
    };
    const tree = await mount();
    // Collapsed: the honest limits are not shouted at every profile.
    const bodyBefore = textOf(tree, 'peer-machine');
    expect(bodyBefore).not.toContain('your own agreement');
    await openInfo(tree);
    const opened = textOf(tree, 'peer-machine');
    // The design: the provider side of the flow is the operator's own vendor
    // agreement. The design: the relay still sees routing metadata. Both belong
    // behind the ⓘ, and neither may go missing from it.
    expect(opened).toContain('your own agreement');
    expect(opened).toContain('who messaged whom');
  });
});

describe('machineFailureCopy speaks only in outcomes the server has', () => {
  it('says "nothing changed" ONLY for refusals the server decides before it mutates', () => {
    const of = (code?: string) =>
      machineFailureCopy(new ApiRequestError('detail', 409, code));
    expect(of('cap_reached')).toContain('full (8');
    expect(of('crew_contended')).toContain('try again');
    expect(of('not_found')).toContain('No such account');
    // A 5xx can arrive AFTER the change landed (revoke
    // tombstones before its cleanup), and a lost response after a success is
    // indistinguishable from a failure. Neither may claim "nothing changed".
    expect(of('internal')).not.toContain('othing changed');
    expect(of('internal')).toContain('may or may not');
    expect(machineFailureCopy(new Error('anything'))).not.toContain('othing changed');
    expect(machineFailureCopy(new Error('anything'))).toContain('may not have gone through');
  });
});
