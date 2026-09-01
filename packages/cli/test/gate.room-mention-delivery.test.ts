import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const home = mkdtempSync(join(tmpdir(), 'tacendum-p5b3-'));
process.env.TACENDUM_HOME = home;

const {
  cmdRoom,
  sendRoomMessage,
  mentionWhoOf,
  roomAgentAuthorIds,
  roomContentRecipients,
  roomRefAuthor,
} = await import('../src/room-commands.js');
type RoomDelivery = import('../src/room-commands.js').RoomDelivery;
type FanoutLeg = import('../src/send.js').FanoutLeg;
const { listRooms } = await import('../src/rooms.js');
const { saveProfile } = await import('../src/profile.js');
const { MessageLog } = await import('../src/msglog.js');
const { Reporter } = await import('../src/output.js');

/**
 * A room CONTENT message reaches an AGENT member only when it
 * @mentions that agent. The CLI mirror of the app rule:
 * `sendRoomMessage` drops the leg of any agent the message does not name — a
 * clean non-send, never a failed/refused leg — while humans always send. The
 * agent set is the CLI's marker-record (`roomAgentAuthorIds`, from the inbound
 * `ai` marker), the only agent-class signal the CLI holds. `realSendRoomReply`
 * funnels through `sendRoomMessage`, so an agent's own bare reply inherits the
 * same exclusion: it reaches the humans and any mentioned agent, never OTHER
 * unmentioned agents.
 */

const OWNER = '01HHHHHHHHHHHHHHHHHHHHHHHH';
const HUMAN = '01BBBBBBBBBBBBBBBBBBBBBBBB';
const AGENT = '01CCCCCCCCCCCCCCCCCCCCCCCC';
const AGENT2 = '01DDDDDDDDDDDDDDDDDDDDDDDD';

for (const [name, userId] of [
  ['owner', OWNER],
  ['int-claude', AGENT], // an agent account, for the realSendRoomReply shape
] as const) {
  saveProfile({
    name,
    identityKey: 'test-key',
    userId,
    authToken: 'test-token',
    registrationId: 1,
    deviceId: 1,
  });
}

function recordingDeliver(captured: FanoutLeg[][]): RoomDelivery {
  return (async ({ legs }: { legs: FanoutLeg[] }) => {
    captured.push(legs);
    return legs.map(l => ({ to: l.to, msgId: l.msgId, state: 'delivered' as const }));
  }) as RoomDelivery;
}

async function runRoom(argv: string[], deliver: RoomDelivery): Promise<number> {
  return cmdRoom(argv, new Reporter({ json: true, plain: true }), deliver);
}

/** Create a room {owner, HUMAN, ...agents} owned by `owner`. */
async function makeRoom(...members: string[]): Promise<string> {
  const captured: FanoutLeg[][] = [];
  const code = await runRoom(['create', 'owner', 'Kitchen', ...members], recordingDeliver(captured));
  expect(code).toBe(0);
  const gid = listRooms('owner')[0]!.groupId;
  return gid;
}

/** Record that `author` spoke AI-marked in `gid` on `account`'s spool — what
 *  inbound.ts writes when an agent's marked wrapper arrives. */
function hearAgent(account: string, gid: string, author: string, n = 1): void {
  new MessageLog(account).append({
    id: `01AGENTROW${String(n).padStart(16, '0')}`,
    dir: 'in',
    peer: author,
    ts: Date.now(),
    tcm: 'grp.msg',
    text: 'hi',
    read: true,
    grp: gid,
    ai: true,
  });
}

/** A structured mention body: one U+FFFC mark per named id. */
function mention(words: string, ids: string[]): string {
  return JSON.stringify({ tcm: 'mention', text: '￼'.repeat(ids.length) + ' ' + words, who: ids });
}

describe('roomContentRecipients — addressed-or-owned (design ruling)', () => {
  const agents = new Set([AGENT, AGENT2]);
  const M = '01MMMMMMMMMMMMMMMMMMMMMMMM';
  const AGENT_ROW = `${AGENT}.${M}`;
  const HUMAN_ROW = `${HUMAN}.${M}`;
  const OWNER_ROW = `${OWNER}.${M}`;
  const reply = (ref: string): string => JSON.stringify({ tcm: 'reply', ref, text: 'go on', ofs: false });
  const edit = (ref: string): string => JSON.stringify({ tcm: 'edit', ref, text: 'new words' });
  const del = (ref: string): string => JSON.stringify({ tcm: 'del', ref });
  const react = (ref: string): string => JSON.stringify({ tcm: 'react', ref, emoji: '❤️', ofs: false });

  it('drops every unaddressed agent on bare chatter, keeps humans', () => {
    expect(roomContentRecipients('rcr', [HUMAN, AGENT, AGENT2], 'anyone around?', agents))
      .toEqual([HUMAN]);
  });

  it('keeps an agent the message @mentions, still drops the other', () => {
    expect(roomContentRecipients('rcr', [HUMAN, AGENT, AGENT2], mention('ping', [AGENT]), agents))
      .toEqual([HUMAN, AGENT]);
  });

  it('a human is never dropped even if (wrongly) unnamed', () => {
    expect(roomContentRecipients('rcr', [HUMAN], 'hi', agents)).toEqual([HUMAN]);
  });

  it('no known agents ⇒ nothing pruned', () => {
    expect(roomContentRecipients('rcr', [HUMAN, AGENT], 'hi', new Set())).toEqual([HUMAN, AGENT]);
  });

  // -- Ruled: reply-to-continue (shares the trigger's roomRefAuthor) --------
  it('reply-to-continue: a reply to the AGENT’s own row keeps that agent, with NO @mention', () => {
    expect(roomContentRecipients('rcr', [HUMAN, AGENT, AGENT2], reply(AGENT_ROW), agents))
      .toEqual([HUMAN, AGENT]);
  });

  it('reply-to-continue to a HUMAN’s row keeps NO agent', () => {
    expect(roomContentRecipients('rcr', [HUMAN, AGENT, AGENT2], reply(HUMAN_ROW), agents))
      .toEqual([HUMAN]);
  });

  // -- Ruled: lifecycle carriers --------------------------------------------
  it('an EDIT excludes every unaddressed agent — a NEW body never leaks', () => {
    expect(roomContentRecipients('rcr', [HUMAN, AGENT, AGENT2], edit(OWNER_ROW), agents))
      .toEqual([HUMAN]);
  });

  it('a DELETE of an aged-out target INCLUDES the agents — a tombstone carries no body', () => {
    // 'empty-spool' holds no such row, so the target is not found (harmless).
    expect(roomContentRecipients('empty-spool', [HUMAN, AGENT, AGENT2], del(OWNER_ROW), agents))
      .toEqual([HUMAN, AGENT, AGENT2]);
  });

  it('a DELETE of a target STILL HELD excludes the agents (the CLI’s own row named none)', () => {
    const acct = 'del-held';
    new MessageLog(acct).append({
      id: OWNER_ROW, dir: 'out', peer: OWNER, ts: Date.now(),
      tcm: 'grp.msg', text: '', read: true, grp: '01GRP0000000000000000000GG',
    });
    expect(roomContentRecipients(acct, [HUMAN, AGENT, AGENT2], del(OWNER_ROW), agents))
      .toEqual([HUMAN]);
  });

  it('a REACTION to the AGENT’s OWN row reaches it (owned-by); to a HUMAN’s row it reaches no agent', () => {
    expect(roomContentRecipients('rcr', [HUMAN, AGENT, AGENT2], react(AGENT_ROW), agents))
      .toEqual([HUMAN, AGENT]);
    expect(roomContentRecipients('rcr', [HUMAN, AGENT, AGENT2], react(HUMAN_ROW), agents))
      .toEqual([HUMAN]);
  });
});

describe('roomRefAuthor — the shared reply-to-continue parser (no drift with the trigger)', () => {
  it('returns the 26-char author component of a room content ref', () => {
    expect(roomRefAuthor(`${AGENT}.01MMMMMMMMMMMMMMMMMMMMMMMM`)).toBe(AGENT);
  });
  it('rejects a malformed ref: a bare id, a short half, or an extra dot', () => {
    expect(roomRefAuthor(AGENT)).toBeNull();
    expect(roomRefAuthor(`${AGENT}.short`)).toBeNull();
    expect(roomRefAuthor(`${AGENT}.${AGENT}.${AGENT}`)).toBeNull();
  });
});

describe('mentionWhoOf', () => {
  it('names the who[] of a structured mention', () => {
    expect(mentionWhoOf(mention('ping', [AGENT, HUMAN]))).toEqual([AGENT, HUMAN]);
  });
  it('bare text names nobody', () => {
    expect(mentionWhoOf('anyone around?')).toEqual([]);
  });
  it('a non-mention envelope names nobody', () => {
    expect(mentionWhoOf('{"tcm":"reply","text":"hi","ref":"x"}')).toEqual([]);
  });
});

describe('sendRoomMessage excludes an unmentioned agent (the real send path)', () => {
  it('a NON-mention grp.msg drops the agent leg but keeps the human — and NOT as a failed/skipped leg', async () => {
    const gid = await makeRoom(HUMAN, AGENT);
    hearAgent('owner', gid, AGENT);

    // Sanity: the marker-record now names the agent.
    expect(roomAgentAuthorIds('owner', gid)).toEqual(new Set([AGENT]));

    const captured: FanoutLeg[][] = [];
    const out = await sendRoomMessage(
      'owner',
      gid,
      'anyone around?',
      recordingDeliver(captured),
    );

    const legs = captured[0] ?? [];
    expect(legs.map(l => l.to)).toEqual([HUMAN]);
    // Clean exclusion: the agent is not a recipient at all — not delivered,
    // not skipped, not failed. Distinct from the consent-refused leg, where a
    // leg is ATTEMPTED and the server refuses.
    expect(out.failed).toEqual([]);
    expect(out.preSkipped).toEqual([]);
    expect(out.delivered).toEqual([HUMAN]);
    expect(out.recipients).toBe(1);
  });

  it('a grp.msg that @mentions the agent DELIVERS to it (and to the human)', async () => {
    const gid = await makeRoom(HUMAN, AGENT);
    hearAgent('owner', gid, AGENT);

    const captured: FanoutLeg[][] = [];
    await sendRoomMessage('owner', gid, mention('ping', [AGENT]), recordingDeliver(captured));

    const to = (captured[0] ?? []).map(l => l.to).sort();
    expect(to).toEqual([AGENT, HUMAN].sort());
  });

  it('a CLASS-ONLY agent — never heard, fold-classed by the owner’s write — is excluded on bare chatter (ruling)', async () => {
    // The roster-class OR-half: no spool row exists for the agent (it has
    // never spoken), but the room store's authority slot classes it, so the
    // exclusion no longer waits for the agent to have spoken. Mirrors the
    // app's owner-excludes-before-speech via machine_peers.
    const gid = '01RRRRRRRRRRRRRRRRRRRRRRRR';
    const { FileGroupStore } = await import('../src/rooms.js');
    const { applyGroupNew } = await import('@tacendum/shared/group-fold');
    const store = FileGroupStore.load('owner', gid);
    applyGroupNew(store, OWNER, {
      writerId: OWNER,
      members: [OWNER, HUMAN, AGENT],
      seq: 1,
      integrations: [AGENT],
    });
    store.setName('ClassOnly');
    store.persist();
    expect(roomAgentAuthorIds('owner', gid)).toEqual(new Set([AGENT]));

    const captured: FanoutLeg[][] = [];
    const out = await sendRoomMessage('owner', gid, 'anyone around?', recordingDeliver(captured));
    expect((captured[0] ?? []).map(l => l.to)).toEqual([HUMAN]);
    expect(out.failed).toEqual([]);
    // …and an @mention still reaches it: class informs, it never silences.
    const captured2: FanoutLeg[][] = [];
    await sendRoomMessage('owner', gid, mention('ping', [AGENT]), recordingDeliver(captured2));
    expect((captured2[0] ?? []).map(l => l.to).sort()).toEqual([AGENT, HUMAN].sort());
  });

  it('an agent-authored bare reply excludes OTHER unmentioned agents but reaches the human (realSendRoomReply shape)', async () => {
    // int-claude (an agent) is a member of a room with a human and a SECOND
    // agent. Its own bare reply (ai:true, as realSendRoomReply sends) must not
    // fan to the other agent.
    const captured0: FanoutLeg[][] = [];
    const code = await runRoom(
      ['create', 'int-claude', 'Kitchen', HUMAN, AGENT2],
      recordingDeliver(captured0),
    );
    expect(code).toBe(0);
    const gid = listRooms('int-claude')[0]!.groupId;
    hearAgent('int-claude', gid, AGENT2);

    const captured: FanoutLeg[][] = [];
    await sendRoomMessage(
      'int-claude',
      gid,
      'here is my answer',
      recordingDeliver(captured),
      () => {},
      { ai: true },
    );

    const legs = captured[0] ?? [];
    expect(legs.map(l => l.to)).toEqual([HUMAN]);
  });
});
