import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * THE REPLY-CONTINUATION FALLBACK. Replying to a message whose conversation attend cannot
 * continue used to draw the dead-end excuse — "That session ended and its
 * record is gone…" — instead of an answer. Measured on the owner's phone:
 * a reply to an MCP-written notify/ask row (no `sess` on the ledger row)
 * and a reply to a notify-hook message whose claude session record was gone
 * both dead-ended.
 *
 * The fallback: when a reply's ref resolves to a row attend cannot continue
 *   (a) an out-row with NO sess (MCP notify/ask rows, hook rows without
 *       session records, codex-exec answers, room-turn side messages),
 *   (b) a routed sess whose session record is gone from the host's store
 *       (`No conversation found`), or
 *   (c) a live-session refusal that survives the --fork-session recovery,
 * the router runs a FRESH turn on the own route, carrying the reply text as
 * the prompt behind ONE supervisor-composed context line quoting the
 * referenced row's own text through the funnel. The referenced text comes
 * from the LOCAL ledger row only — never re-fetched — and today every out
 * row deliberately stores `text: ''`, so the no-text form of the line is
 * the common case. The excuse survives ONLY where a fresh turn cannot run:
 * a ref that resolves to NOTHING locally (nothing to quote — the honest
 * no-guess), a tampered sess-bearing row (gate.session-argv's pin — a bad
 * credential is not a conversation), a room ref (the room arm's own rules),
 * and an empty budget (the throttle sentence already covers it).
 */

const home = mkdtempSync(join(tmpdir(), 'tacendum-reply-carry-'));
process.env.TACENDUM_HOME = home;
process.env.TACENDUM_API = 'http://carry.test';
process.env.TACENDUM_WS = 'ws://carry.test';

const { attendOnce, saveAttendConfig } = await import('../src/attend.js');
const { MessageLog } = await import('../src/msglog.js');
const { saveProfile } = await import('../src/profile.js');

const OWNER = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const SESSION_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const OWN_SESSION = 'ffffffff-9999-4999-8999-999999999999';

/** The context line's two forms, pinned as BYTES: the copy is part of the
 * contract (it rides inside the prompt to the host — never into logs). */
const CTX_NO_TEXT = '[replying to an earlier message from this agent; its text was not kept]';
const ctxQuoting = (head: string): string => `[replying to: "${head}"]`;

/** claude's own words, verbatim (attend.test.ts's provenance note). */
const REFUSAL = {
  noConversation: (id: string) => `No conversation found with session ID: ${id}\n`,
  live: (id: string) =>
    `Error: Session ${id} is currently running as a background agent (background). ` +
    'Use `claude agents` to find and attach to it, or add --fork-session to branch off a copy.\n',
};

let seq = 0;
const mid = (): string => `01HQXWCARRY000000000${String(++seq).padStart(6, '0')}`.slice(0, 26);

function inReply(text: string, ref: string) {
  return {
    id: mid(), dir: 'in' as const, peer: OWNER, ts: Date.now(),
    tcm: 'reply', text, read: false, ref,
  };
}

function bareIn(text: string) {
  return { id: mid(), dir: 'in' as const, peer: OWNER, ts: Date.now(), tcm: '', text, read: false };
}

/** A sessionless out row — the MCP notify/ask and hook-without-session
 * ledger shape (text '' from birth: "the row is routing, not truth"). */
function outNoSess(text = ''): string {
  const id = mid();
  new MessageLog('bot').append({
    id, dir: 'out', peer: OWNER, ts: Date.now(), tcm: '', text, read: true,
  });
  return id;
}

function outWithSess(sessKey: string): string {
  const id = mid();
  new MessageLog('bot').append({
    id, dir: 'out', peer: OWNER, ts: Date.now(), tcm: '', text: '', read: true,
    sess: { host: 'claude', key: sessKey, tag: 'repo' },
  });
  return id;
}

const bucketTurns = (): number =>
  JSON.parse(readFileSync(join(home, 'state', 'bot', 'attend-bucket.json'), 'utf8')).turns;

type Answer = { stdout: string; stderr?: string; code: number };

const harness = () => {
  const replies: { body: string; sess?: { host: string; key?: string; tag?: string } }[] = [];
  const turns: { argv: string[]; cwd: string; prompt: string }[] = [];
  let answers: Answer[] = [{ stdout: 'done: shipped', code: 0 }];
  let i = 0;
  return {
    replies, turns,
    script: (a: Answer[]) => { answers = a; i = 0; },
    io: {
      sendReply: async (b: string, sess?: { host: string; key?: string; tag?: string }) =>
        void replies.push({ body: b, ...(sess !== undefined ? { sess } : {}) }),
      runTurn: async (argv: string[], cwd: string, prompt: string) => {
        turns.push({ argv, cwd, prompt });
        const a = answers[i] ?? (answers[answers.length - 1] as Answer);
        i += 1;
        return a;
      },
    },
  };
};

beforeEach(() => {
  rmSync(join(home, 'bot'), { recursive: true, force: true });
  rmSync(join(home, 'state'), { recursive: true, force: true });
  seq = 0;
  saveProfile({
    name: 'bot', identityKey: 'AAAA', userId: '01HQXW0000000000000000TEST',
    deviceId: 1, authToken: 'tok', registrationId: 1,
    accountClass: 'integration', ownerUserId: OWNER,
  });
  saveAttendConfig('bot', {
    host: 'claude', bin: '/opt/agent', workdir: '/w', caps: ['--permission-mode', 'plan'],
    ownSession: OWN_SESSION, turnsPerHour: 10,
  });
});

describe('(a) a reply to a sessionless out row runs a fresh turn, not the excuse', () => {
  it('the MCP-row shape: fresh own turn, context line + reply as the prompt bytes', async () => {
    const ref = outNoSess(); // text '' — the shipped MCP/hook ledger shape
    new MessageLog('bot').append(inReply('also do the docs', ref));
    const h = harness();
    expect(await attendOnce('bot', h.io)).toBe('answered');
    expect(h.turns, 'a fresh turn must run — the dead-end excuse is gone').toHaveLength(1);
    // The OWN route, create form: this reply belongs to no resumable session.
    expect(h.turns[0]!.argv.join(' ')).toContain(`--session-id=${OWN_SESSION}`);
    expect(h.turns[0]!.argv.join(' ')).not.toContain('--resume');
    // THE PROMPT BYTES: one context line, then the owner's words, verbatim.
    expect(h.turns[0]!.prompt).toBe(`${CTX_NO_TEXT}\nalso do the docs`);
    expect(h.replies[0]?.body).toBe('done: shipped');
    expect(h.replies[0]?.body).not.toContain('That session ended');
    // The answer speaks for the own session — the NEXT reply continues it.
    expect(h.replies[0]?.sess?.key).toBe(OWN_SESSION);
    // Ordinary rails: the cursor advanced; nothing is re-answered.
    expect(await attendOnce('bot', h.io)).toBe('idle');
  });

  it('a referenced row that DOES carry text is quoted through the funnel, one line, capped', async () => {
    // No shipped writer stores out-row text today (text '' is deliberate:
    // "routing, not truth") — but a backup-restored or future row that does
    // is quoted rather than ignored, newlines collapsed to one line.
    const ref = outNoSess('Deploy finished.\nLogs are clean.');
    new MessageLog('bot').append(inReply('ship the docs too', ref));
    const h = harness();
    expect(await attendOnce('bot', h.io)).toBe('answered');
    expect(h.turns[0]!.prompt).toBe(
      `${ctxQuoting('Deploy finished. Logs are clean.')}\nship the docs too`,
    );
  });

  it('an over-cap referent is head-kept under the chat cap — the line stays a line', async () => {
    const ref = outNoSess('a'.repeat(400));
    new MessageLog('bot').append(inReply('go on', ref));
    const h = harness();
    expect(await attendOnce('bot', h.io)).toBe('answered');
    const [line, ...rest] = h.turns[0]!.prompt.split('\n');
    expect(rest.join('\n')).toBe('go on');
    expect(line!.startsWith('[replying to: "')).toBe(true);
    expect(line!.length, 'the quoted head is bounded by the 280 chat cap plus the frame')
      .toBeLessThanOrEqual(280 + '[replying to: ""]'.length);
    expect(line!).toContain('…');
  });

  it('two replies to the SAME dead row share one turn and ONE context line', async () => {
    const ref = outNoSess();
    new MessageLog('bot').append(inReply('first', ref));
    new MessageLog('bot').append(inReply('second', ref));
    const h = harness();
    expect(await attendOnce('bot', h.io)).toBe('answered');
    expect(h.turns).toHaveLength(1);
    expect(h.turns[0]!.prompt).toBe(`${CTX_NO_TEXT}\nfirst\n\nsecond`);
  });

  it('replies to DIFFERENT dead rows never merge into one turn', async () => {
    const refA = outNoSess();
    const refB = outNoSess();
    new MessageLog('bot').append(inReply('for A', refA));
    new MessageLog('bot').append(inReply('for B', refB));
    const h = harness();
    expect(await attendOnce('bot', h.io)).toBe('answered');
    expect(h.turns[0]!.prompt).toBe(`${CTX_NO_TEXT}\nfor A`);
    expect(await attendOnce('bot', h.io)).toBe('answered');
    expect(h.turns[1]!.prompt).toBe(`${CTX_NO_TEXT}\nfor B`);
  });
});

describe('(b)/(c) a routed session the host refuses at startup falls back to a fresh turn', () => {
  it('record gone: the no-conversation refusal buys a fresh own turn, same token, id never echoed', async () => {
    const ref = outWithSess(SESSION_A);
    new MessageLog('bot').append(inReply('and the tests?', ref));
    const h = harness();
    h.script([
      { stdout: '', stderr: REFUSAL.noConversation(SESSION_A), code: 1 },
      { stdout: 'fresh: picking this up', code: 0 },
    ]);
    expect(await attendOnce('bot', h.io)).toBe('answered');
    expect(h.turns, 'resume attempt, then the fallback — exactly two spawns').toHaveLength(2);
    expect(h.turns[0]!.argv.join(' ')).toContain(`--resume=${SESSION_A}`);
    expect(h.turns[1]!.argv.join(' ')).toContain(`--session-id=${OWN_SESSION}`);
    expect(h.turns[1]!.argv.join(' ')).not.toContain(SESSION_A);
    expect(h.turns[1]!.prompt).toBe(`${CTX_NO_TEXT}\nand the tests?`);
    // The answer, not the excuse — and nothing the host said leaks through.
    expect(h.replies[0]?.body).toBe('fresh: picking this up');
    for (const r of h.replies) {
      expect(r.body).not.toContain('gone from this machine');
      expect(r.body).not.toContain('No conversation found');
      expect(r.body).not.toContain(SESSION_A);
    }
    // The fallback answer speaks for the OWN session, so the conversation
    // continues there instead of looping through the dead key.
    expect(h.replies[0]?.sess?.key).toBe(OWN_SESSION);
    expect(bucketTurns(), 'a startup refusal is model-free — one token buys the fallback').toBe(1);
    expect(await attendOnce('bot', h.io)).toBe('idle');
  });

  it('live and unforkable: the fork recovery is tried FIRST; only its refusal buys the fallback', async () => {
    const ref = outWithSess(SESSION_A);
    new MessageLog('bot').append(inReply('status?', ref));
    const h = harness();
    h.script([
      { stdout: '', stderr: REFUSAL.live(SESSION_A), code: 1 },
      { stdout: '', stderr: REFUSAL.live(SESSION_A), code: 1 },
      { stdout: 'answered beside nothing: here is where things stand', code: 0 },
    ]);
    expect(await attendOnce('bot', h.io)).toBe('answered');
    expect(h.turns).toHaveLength(3);
    expect(h.turns[1]!.argv, 'genuine continuation is attempted before any fallback')
      .toContain('--fork-session');
    expect(h.turns[2]!.argv.join(' ')).toContain(`--session-id=${OWN_SESSION}`);
    expect(h.turns[2]!.prompt).toBe(`${CTX_NO_TEXT}\nstatus?`);
    expect(h.replies[0]?.body).toBe('answered beside nothing: here is where things stand');
    expect(bucketTurns()).toBe(1);
  });

  it('the fallback never preempts genuine continuation: a working fork answers beside the live session', async () => {
    const ref = outWithSess(SESSION_A);
    new MessageLog('bot').append(inReply('status?', ref));
    const h = harness();
    h.script([
      { stdout: '', stderr: REFUSAL.live(SESSION_A), code: 1 },
      { stdout: 'beside it: fine', code: 0 },
    ]);
    expect(await attendOnce('bot', h.io)).toBe('answered');
    expect(h.turns, 'the fork succeeded — no third spawn').toHaveLength(2);
    expect(h.turns[1]!.prompt, 'a continued conversation needs no context line').toBe('status?');
    expect(h.replies[0]?.body).toBe('beside it: fine');
  });

  it('a healthy resume is untouched: one spawn, the raw reply as the prompt', async () => {
    const ref = outWithSess(SESSION_A);
    new MessageLog('bot').append(inReply('yes proceed', ref));
    const h = harness();
    expect(await attendOnce('bot', h.io)).toBe('answered');
    expect(h.turns).toHaveLength(1);
    expect(h.turns[0]!.prompt).toBe('yes proceed');
    expect(h.turns[0]!.prompt).not.toContain('[replying');
  });

  it('a turn that genuinely RAN and failed keeps the honest failure reply — no free re-run', async () => {
    const ref = outWithSess(SESSION_A);
    new MessageLog('bot').append(inReply('go', ref));
    const h = harness();
    h.script([{ stdout: 'I got halfway and then', stderr: 'Error: connection reset\n', code: 1 }]);
    expect(await attendOnce('bot', h.io)).toBe('failed');
    expect(h.turns, 'a non-refusal failure spent real budget — never respawned').toHaveLength(1);
    expect(h.replies[0]?.body).toContain('I got halfway and then');
  });
});

describe('where the excuse honestly survives', () => {
  it('a ref that resolves to NOTHING local still gets the ended answer — nothing to quote, no guess', async () => {
    new MessageLog('bot').append(inReply('yes', '01HQXWNEVERRECORDED0000000'));
    const h = harness();
    expect(await attendOnce('bot', h.io)).toBe('ended');
    expect(h.turns).toHaveLength(0);
    expect(h.replies[0]?.body).toContain('That session ended and its record is gone');
  });

  it('a BARE text routed to a dead live session keeps the failure reply — nothing was replied to', async () => {
    // Router rule 2 (one live session, no ref) can also reach the refusal —
    // but with no referenced message a "[replying to …]" line would put
    // words in the owner's mouth. The fallback is a REPLY's, only.
    outWithSess(SESSION_A);
    new MessageLog('bot').append(bareIn('status?'));
    const h = harness();
    h.script([{ stdout: '', stderr: REFUSAL.noConversation(SESSION_A), code: 1 }]);
    expect(await attendOnce('bot', h.io)).toBe('failed');
    expect(h.turns, 'no ref, no fallback spawn').toHaveLength(1);
    expect(h.replies[0]?.body).toContain('gone from this machine');
  });

  it('budget empty: the throttle sentence covers it — no crash, no turn, no excuse-loop', async () => {
    saveAttendConfig('bot', {
      host: 'claude', bin: '/opt/agent', workdir: '/w', caps: ['--permission-mode', 'plan'],
      ownSession: OWN_SESSION, turnsPerHour: 1,
    });
    new MessageLog('bot').append(bareIn('warm up'));
    const h = harness();
    expect(await attendOnce('bot', h.io)).toBe('answered'); // burns the hour's one token
    const ref = outNoSess();
    new MessageLog('bot').append(inReply('and now this', ref));
    expect(await attendOnce('bot', h.io)).toBe('throttled');
    expect(h.turns, 'no token, no turn').toHaveLength(1);
    expect(h.replies[1]?.body).toContain('hourly turn limit');
  });
});
