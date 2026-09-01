import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The review peer.
 *
 * Four properties, and they are not independent — each of the last three is
 * what makes the first one survivable:
 *
 *  1. it answers ANYONE (attend answers only the owner, and that predicate is
 *     a security boundary this file must never be read as widening);
 *  2. the reply is CANNED — no agent, no child process, no prompt — which is
 *     the whole reason (1) is not a prompt-injection surface;
 *  3. a PER-PEER budget, on disk, so it is neither a spam reflector nor fast
 *     enough to trip the server's 4/min notification-wake suppression;
 *  4. a CURSOR, so a restart neither loses a message nor answers one twice.
 *
 * IN-PROCESS ONLY, DELIBERATELY. main.ts registers `review-peer run` and
 * `review-peer service …` now (gate.unit-program-registered.test.ts
 * proves the registration against the built entry, per ServiceVariant), but
 * this file still drives the module directly: the service manager rides the
 * `exec` seam, which keeps this file in vitest's fast project —
 * `node:child_process` is the signature `suite-classification.test.ts`
 * enforces against, and importing it here would misfile the file under a 15s
 * cap sized for pure CPU work.
 */

const home = mkdtempSync(join(tmpdir(), 'tacendum-review-peer-'));
process.env.TACENDUM_HOME = home;
process.env.TACENDUM_API = 'http://review-peer.test';
process.env.TACENDUM_WS = 'ws://review-peer.test';

const mod = await import('../src/review-peer.js');
const {
  REVIEW_PEER_PER_DAY,
  REVIEW_PEER_PER_MINUTE,
  REVIEW_PEER_REPLIES,
  cmdReviewPeerService,
  pendingRows,
  reviewPeerOnce,
  reviewReplies,
  saveReviewPeerConfig,
  takeReplyToken,
  triggers,
} = mod;
const { MessageLog } = await import('../src/msglog.js');
const { saveProfile } = await import('../src/profile.js');
const { CliError } = await import('../src/exit.js');
const { unitPathFor } = await import('../src/service.js');
const { Reporter } = await import('../src/output.js');

/** Two strangers. NEITHER is the account's owner — that is the point. */
const PEER_A = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const PEER_B = '01BX5ZZKBKACTAV9WEVGEMMVRY';
/**
 * A decoy `ownerUserId` in the profile. A human-class account has no owner
 * binding, but the field EXISTS on the record, and "reply to the owner" is
 * exactly what a copy of attend's send path would do — so the profile carries
 * a value that a wrong implementation would find and a right one never reads.
 */
const OWNER_DECOY = '01D0ABCDEFGHJKMNPQRSTVWXYZ';

const T = Date.parse('2026-08-05T12:00:00.000Z');
const MINUTE = 60_000;

let seq = 0;
const mid = (): string => `01HQXW00000000000000${String(++seq).padStart(6, '0')}`.slice(0, 26);

function inRow(text: string, opts: { peer?: string; tcm?: string } = {}) {
  return {
    id: mid(),
    dir: 'in' as const,
    peer: opts.peer ?? PEER_A,
    ts: Date.now(),
    tcm: opts.tcm ?? '',
    text,
    read: false,
  };
}

const append = (row: ReturnType<typeof inRow>): void => void new MessageLog('bot').append(row);

function humanProfile(): void {
  saveProfile({
    name: 'bot',
    identityKey: 'AAAA',
    userId: '01HQXW0000000000000000TEST',
    deviceId: 1,
    authToken: 'tok',
    registrationId: 1,
    // NO accountClass: this is a human-class registration, which is the whole
    // point of the design — an integration cannot be reached by a stranger at all.
    ownerUserId: OWNER_DECOY,
  });
}

beforeEach(() => {
  rmSync(join(home, 'bot'), { recursive: true, force: true });
  rmSync(join(home, 'state'), { recursive: true, force: true });
  seq = 0;
  humanProfile();
});

const harness = () => {
  const sent: { to: string; body: string }[] = [];
  return {
    sent,
    io: { sendReply: async (to: string, body: string) => void sent.push({ to, body }) },
  };
};

/** One pass at a fixed clock. */
const pass = (h: ReturnType<typeof harness>, now: number) =>
  reviewPeerOnce('bot', { ...h.io, now: () => now });

describe('the predicate: five conditions, and no peer test', () => {
  it('inbound conversational text triggers; the other four conditions each flip it', () => {
    expect(triggers(inRow('hello'))).toBe(true);
    expect(triggers(inRow('yes', { tcm: 'reply' }))).toBe(true);
    // 1. direction
    expect(triggers({ ...inRow('our own line'), dir: 'out' as const })).toBe(false);
    // 2. envelope kind — a carrier is not a message to answer
    expect(triggers(inRow('x', { tcm: 'image' }))).toBe(false);
    // 3. redacted: the body is already gone
    expect(triggers({ ...inRow('gone'), red: true })).toBe(false);
    // 4. empty text: nothing was said
    expect(triggers(inRow(''))).toBe(false);
  });

  it('a STRANGER triggers — the difference from attend, stated as an assertion', () => {
    // attend's predicate would reject both of these: neither peer is the
    // account's owner, and the decoy owner in the profile is a third party
    // neither of them is.
    expect(triggers(inRow('hi', { peer: PEER_A }))).toBe(true);
    expect(triggers(inRow('hi', { peer: PEER_B }))).toBe(true);
    expect(PEER_A).not.toBe(OWNER_DECOY);
  });

  it('pendingRows applies the predicate, not just the cursor', () => {
    append(inRow('answer me'));
    append(inRow('x', { tcm: 'image' }));
    append(inRow(''));
    expect(pendingRows('bot').map(r => r.text)).toEqual(['answer me']);
  });
});

describe('the reply goes to whoever wrote', () => {
  it('answers the SENDER, never the profile owner field', async () => {
    append(inRow('hello?', { peer: PEER_B }));
    const h = harness();
    expect(await pass(h, T)).toBe('replied');
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.to).toBe(PEER_B);
    expect(h.sent[0]?.to).not.toBe(OWNER_DECOY);
    expect(h.sent[0]?.body).toBe(REVIEW_PEER_REPLIES[0]);
  });

  it('two peers in one batch each get their own reply, addressed to themselves', async () => {
    append(inRow('from A', { peer: PEER_A }));
    append(inRow('from B', { peer: PEER_B }));
    const h = harness();
    await pass(h, T);
    expect(h.sent.map(s => s.to)).toEqual([PEER_A, PEER_B]);
    // Per-peer rotation: each stranger starts at the sentence that says what
    // this is, rather than one of them landing mid-rotation.
    expect(h.sent.map(s => s.body)).toEqual([REVIEW_PEER_REPLIES[0], REVIEW_PEER_REPLIES[0]]);
  });

  it('nothing pending is idle, and sends nothing', async () => {
    const h = harness();
    expect(await pass(h, T)).toBe('idle');
    expect(h.sent).toEqual([]);
  });
});

describe('the rotation', () => {
  it('advances per reply and wraps, per peer', async () => {
    // Three in one minute is exactly the cap, so the fourth is taken a minute
    // later — this test is about the rotation, not the budget.
    append(inRow('one'));
    append(inRow('two'));
    append(inRow('three'));
    const h = harness();
    await pass(h, T);
    expect(h.sent.map(s => s.body)).toEqual([...REVIEW_PEER_REPLIES]);

    append(inRow('four'));
    await pass(h, T + MINUTE + 1_000);
    expect(h.sent[3]?.body).toBe(REVIEW_PEER_REPLIES[0]);
  });

  it('the shipped rotation survives the outbound funnel unchanged', () => {
    // Which is what makes every body assertion above legitimate: the copy is
    // plain enough that flattening and the 280-character cap are identities on
    // it. If somebody writes markdown or a paragraph into the default, this
    // fails rather than the assertions silently comparing funnelled text.
    expect(reviewReplies('bot')).toEqual([...REVIEW_PEER_REPLIES]);
  });
});

describe('the per-peer budget', () => {
  it('stops the fourth reply inside a minute while a second peer still gets answered', async () => {
    for (let i = 0; i < REVIEW_PEER_PER_MINUTE + 1; i += 1) append(inRow(`msg ${i}`, { peer: PEER_A }));
    append(inRow('and me', { peer: PEER_B }));
    const h = harness();
    expect(await pass(h, T)).toBe('replied');

    const toA = h.sent.filter(s => s.to === PEER_A);
    const toB = h.sent.filter(s => s.to === PEER_B);
    expect(toA).toHaveLength(REVIEW_PEER_PER_MINUTE);
    expect(toB).toHaveLength(1); // the cap is PER PEER, not per account
  });

  it('a capped peer is answered again a minute later, and its refusals did not extend the block', async () => {
    for (let i = 0; i < REVIEW_PEER_PER_MINUTE; i += 1) append(inRow(`msg ${i}`));
    const h = harness();
    await pass(h, T);
    expect(h.sent).toHaveLength(REVIEW_PEER_PER_MINUTE);

    // Knocking while capped, repeatedly, at the far end of the window. If a
    // refusal recorded a stamp, these would push the window forward and the
    // reply after the minute would be refused too — a rate limit administered
    // by the flooder.
    for (let i = 0; i < 5; i += 1) {
      append(inRow(`flood ${i}`));
      expect(await pass(h, T + MINUTE - 1)).toBe('throttled');
    }
    expect(h.sent).toHaveLength(REVIEW_PEER_PER_MINUTE);

    append(inRow('after the window'));
    expect(await pass(h, T + MINUTE + 1)).toBe('replied');
    expect(h.sent).toHaveLength(REVIEW_PEER_PER_MINUTE + 1);
  });

  it('a throttled row is not held back — the flood is not replayed when the window reopens', async () => {
    for (let i = 0; i < REVIEW_PEER_PER_MINUTE + 4; i += 1) append(inRow(`msg ${i}`));
    const h = harness();
    await pass(h, T);
    expect(h.sent).toHaveLength(REVIEW_PEER_PER_MINUTE);

    // A minute later there is nothing pending: the four rows that were over
    // budget were stepped over, not queued.
    expect(await pass(h, T + MINUTE + 1)).toBe('idle');
    expect(h.sent).toHaveLength(REVIEW_PEER_PER_MINUTE);
  });

  it('the day cap holds after the minute cap has stopped mattering, and is per peer', () => {
    // Three per minute, ten minutes apart-enough that the minute window is
    // always empty — so the only thing that can refuse the 31st is the day.
    let taken = 0;
    for (let m = 0; m < REVIEW_PEER_PER_DAY / REVIEW_PEER_PER_MINUTE; m += 1) {
      for (let i = 0; i < REVIEW_PEER_PER_MINUTE; i += 1) {
        expect(takeReplyToken('bot', PEER_A, T + m * (MINUTE + 1_000))).not.toBeNull();
        taken += 1;
      }
    }
    expect(taken).toBe(REVIEW_PEER_PER_DAY);

    const atCap = T + 10 * (MINUTE + 1_000);
    expect(takeReplyToken('bot', PEER_A, atCap)).toBeNull();
    // Same instant, different peer: the day cap is a per-peer fact too.
    expect(takeReplyToken('bot', PEER_B, atCap)).not.toBeNull();
  });

  it('the day window rolls: a peer capped now is answerable once its oldest reply ages out', () => {
    for (let m = 0; m < REVIEW_PEER_PER_DAY / REVIEW_PEER_PER_MINUTE; m += 1) {
      for (let i = 0; i < REVIEW_PEER_PER_MINUTE; i += 1) {
        takeReplyToken('bot', PEER_A, T + m * (MINUTE + 1_000));
      }
    }
    const atCap = T + 10 * (MINUTE + 1_000);
    expect(takeReplyToken('bot', PEER_A, atCap)).toBeNull();
    // A day and a beat after the FIRST three, exactly those three have aged
    // out — so there is room again, and only as much room as aged out.
    const nextDay = T + 24 * 60 * MINUTE + 1_000;
    expect(takeReplyToken('bot', PEER_A, nextDay)).not.toBeNull();
  });
});

/**
 * A RESTART IS A FRESH MODULE OVER THE SAME STATE DIRECTORY. `vi.resetModules`
 * plus a re-import gives exactly that: every module-level binding is rebuilt
 * and nothing survives except what is on disk — which is the property under
 * test, since an in-memory budget is not a budget, it is a counter a
 * crash-loop launders.
 */
async function restart(): Promise<typeof mod> {
  vi.resetModules();
  return (await import('../src/review-peer.js')) as typeof mod;
}

describe('a restart resets nothing', () => {
  it('the budget survives it', async () => {
    for (let i = 0; i < REVIEW_PEER_PER_MINUTE; i += 1) {
      expect(takeReplyToken('bot', PEER_A, T)).not.toBeNull();
    }
    const fresh = await restart();
    expect(fresh.takeReplyToken('bot', PEER_A, T)).toBeNull();
    // …and it is the WINDOW that survived, not a wedged file: the same fresh
    // module answers again once the minute has passed.
    expect(fresh.takeReplyToken('bot', PEER_A, T + MINUTE + 1)).not.toBeNull();
  });

  it('the rotation survives it: the peer does not get the greeting twice', async () => {
    append(inRow('first'));
    const h = harness();
    await pass(h, T);
    expect(h.sent[0]?.body).toBe(REVIEW_PEER_REPLIES[0]);

    const fresh = await restart();
    append(inRow('second'));
    await fresh.reviewPeerOnce('bot', { ...h.io, now: () => T + MINUTE + 1 });
    expect(h.sent[1]?.body).toBe(REVIEW_PEER_REPLIES[1]);
  });

  it('the cursor survives it: an answered message is not answered twice', async () => {
    append(inRow('only once please'));
    const h = harness();
    await pass(h, T);
    expect(h.sent).toHaveLength(1);

    const fresh = await restart();
    expect(await fresh.reviewPeerOnce('bot', { ...h.io, now: () => T + MINUTE + 1 })).toBe('idle');
    expect(h.sent).toHaveLength(1);
  });

  it('and the cursor is a watermark, not the read flag — nothing is marked read', async () => {
    append(inRow('hello'));
    const h = harness();
    await pass(h, T);
    // markRead would start the 24-hour body-purge clock and empty the
    // operator's unread view. The row stays exactly as it arrived.
    expect(new MessageLog('bot').read({ dir: 'in' })[0]?.read).toBe(false);
  });
});

describe('the account class is a precondition, not a runtime surprise', () => {
  it('refuses an integration-class account, by name, before sending anything', async () => {
    saveProfile({
      name: 'bot',
      identityKey: 'AAAA',
      userId: '01HQXW0000000000000000TEST',
      deviceId: 1,
      authToken: 'tok',
      registrationId: 1,
      accountClass: 'integration',
      ownerUserId: OWNER_DECOY,
    });
    append(inRow('hello from a reviewer'));
    const h = harness();
    // The server would 403 this in both directions; failing here says WHY,
    // instead of leaving a peer that receives nothing and answers nothing.
    await expect(pass(h, T)).rejects.toThrow(CliError);
    await expect(pass(h, T)).rejects.toThrow(/human-class/i);
    expect(h.sent).toEqual([]);
    // And it did not quietly consume the message on the way out.
    expect(pendingRows('bot')).toHaveLength(1);
  });

  it('a human-class account with the same rows answers', async () => {
    humanProfile();
    append(inRow('hello from a reviewer'));
    const h = harness();
    expect(await pass(h, T)).toBe('replied');
  });
});

describe('the rotation is configurable, at 0600, and cannot mute the peer', () => {
  it('a config file replaces the rotation and is written 0600', async () => {
    saveReviewPeerConfig('bot', { replies: ['one fixed line', 'another fixed line'] });
    const mode = statSync(join(home, 'bot', 'review-peer.json')).mode & 0o777;
    expect(mode).toBe(0o600);

    append(inRow('hi'));
    const h = harness();
    await pass(h, T);
    expect(h.sent[0]?.body).toBe('one fixed line');
  });

  it('unusable entries are dropped at load, and an unusable file falls back rather than muting', () => {
    // The funnel runs at LOAD: an entry that flattens to nothing would
    // otherwise be sent as an empty message and counted as an answer.
    saveReviewPeerConfig('bot', {
      replies: ['   ', '```\n```', 'the survivor', 42 as unknown as string],
    });
    expect(reviewReplies('bot')).toEqual(['the survivor']);

    saveReviewPeerConfig('bot', { replies: ['', '   '] });
    expect(reviewReplies('bot')).toEqual([...REVIEW_PEER_REPLIES]);
  });
});

/**
 * The service wrapper. What distinguishes it from attend's is WHICH
 * state install refuses: there is no `review-peer enable` and no required
 * config — `reviewReplies` ships a default rotation — so a config-presence
 * check would refuse nothing. The state whose installed unit dies at startup
 * (and is then relaunched into the same refusal once a minute, forever) is
 * the integration-class account, the one `reviewPeerOnce` refuses by name.
 */
describe('the service wrapper refuses the account class, not a config file', () => {
  const report = () => new Reporter({ json: false, plain: true });
  const seam = () => {
    const calls: { file: string; args: string[] }[] = [];
    const unitDir = mkdtempSync(join(tmpdir(), 'review-peer-units-'));
    return {
      calls,
      unitDir,
      io: {
        unitDir,
        platform: 'darwin' as const,
        nodePath: '/n',
        entryPath: '/e',
        exec: (file: string, args: string[]): string => {
          calls.push({ file, args });
          return '';
        },
      },
    };
  };

  it('install on an integration-class account is refused with the SAME sentence the loop dies of', () => {
    saveProfile({
      name: 'bot',
      identityKey: 'AAAA',
      userId: '01HQXW0000000000000000TEST',
      deviceId: 1,
      authToken: 'tok',
      registrationId: 1,
      accountClass: 'integration',
      ownerUserId: OWNER_DECOY,
    });
    const s = seam();
    expect(() => cmdReviewPeerService('install', 'bot', report(), s.io)).toThrow(/human-class/i);
    // Refused BEFORE the manager was touched and before any unit landed —
    // the whole point is that the crash-loop never gets installed.
    expect(s.calls).toHaveLength(0);
    expect(statSync(s.unitDir).isDirectory()).toBe(true);
    expect(() => statSync(unitPathFor('bot', s.io, 'review-peer'))).toThrow();
    rmSync(s.unitDir, { recursive: true, force: true });
  });

  it('a human-class account installs with NO config file — a config check would refuse nothing', () => {
    // beforeEach saved the human-class profile and cleared the account dir,
    // so review-peer.json does not exist. Install must proceed anyway: the
    // shipped rotation is the config.
    const s = seam();
    cmdReviewPeerService('install', 'bot', report(), s.io);
    expect(statSync(unitPathFor('bot', s.io, 'review-peer')).isFile()).toBe(true);
    expect(s.calls.map(c => c.args[0])).toEqual(['bootout', 'bootstrap']);

    // And the rest of the verbs pass straight through to the shared
    // machinery, still under the review-peer variant.
    cmdReviewPeerService('status', 'bot', report(), s.io);
    cmdReviewPeerService('uninstall', 'bot', report(), s.io);
    expect(() => statSync(unitPathFor('bot', s.io, 'review-peer'))).toThrow();
    rmSync(s.unitDir, { recursive: true, force: true });
  });
});

describe('there is no agent behind this', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../src/review-peer.ts', import.meta.url)),
    'utf8',
  );

  it('the module names no subprocess machinery anywhere, comments included', () => {
    // The open predicate is safe ONLY because the reply is canned.
    // This assertion is what keeps the two from being
    // relaxed independently: the day somebody puts a turn behind this
    // responder, they have to delete this test to do it.
    for (const forbidden of [
      /\bchild_process\b/,
      /\bspawn(Sync)?\b/,
      /\bexec[A-Za-z]*\b/,
      /\bfork\b/,
      /\beval\s*\(/,
      /\bnew Function\b/,
      /node:vm/,
    ]) {
      expect(forbidden.test(source), `review-peer.ts matches ${forbidden}`).toBe(false);
    }
  });

  it('and it does not import attend — the owner-only predicate stays untouched', () => {
    expect(/from '\.\/attend\.js'/.test(source)).toBe(false);
    expect(/import\(['"]\.\/attend/.test(source)).toBe(false);
  });
});
