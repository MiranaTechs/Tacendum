import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ApprovalAsk, ApprovalDecision, OutSess } from '../src/attend.js';
import type { HostDriver, TurnRequest } from '../src/attend-drivers.js';

/**
 * THE APPROVAL SPINE — request → reply → decision on the
 * shipped build, proven against a FAKE APPROVING DRIVER because neither
 * shipped driver can produce an approval; that measured fact is why the spine
 * ships first. What is gated here is the control flow the drivers will stand
 * on: the outbound ledger row attend never wrote, the journal's write order
 * and its restart rule, the answer channel that is never a prompt, the cursor
 * rule that loses no message, the two verbs, the over-cap refusal, and the
 * TTL — every deadline on a MOVING clock (a pinned `now()`
 * beside advancing timers hides deadline defects).
 */

const home = mkdtempSync(join(tmpdir(), 'tacendum-approval-spine-'));
process.env.TACENDUM_HOME = home;
process.env.TACENDUM_API = 'http://approval-spine.test';
process.env.TACENDUM_WS = 'ws://approval-spine.test';

/**
 * The two seams this file fakes, and why each is legitimate:
 *
 *  - `driverFor` returns the fake approving driver when a test installs one —
 *    the spine's whole premise is that the supervisor's side must work before
 *    any real driver can ask. Everything else in attend-drivers is the real
 *    module.
 *  - `sendEncrypted` is the network. The spool, the cursor, the turn lock,
 *    the approval journal and the ledger row are all REAL files in a real
 *    temp home; only the socket is faked, so `realSendReply`'s row-writing
 *    contract is exercised for real (send.ts's own suite owns the wire).
 */
const seams = vi.hoisted(() => ({
  driver: null as HostDriver | null,
  sendCalls: [] as { to: string; body: string; msgId?: string }[],
  sendFail: 0,
  fanout: 0,
}));

vi.mock('../src/attend-drivers.js', async importOriginal => {
  const real = await importOriginal<typeof import('../src/attend-drivers.js')>();
  return {
    ...real,
    driverFor: (host: Parameters<typeof real.driverFor>[0]) =>
      seams.driver ?? real.driverFor(host),
  };
});

vi.mock('../src/send.js', async importOriginal => {
  const real = await importOriginal<typeof import('../src/send.js')>();
  return {
    ...real,
    sendEncrypted: async (args: { to: string; body: string; msgId?: string }) => {
      seams.sendCalls.push({ to: args.to, body: args.body, ...(args.msgId ? { msgId: args.msgId } : {}) });
      if (seams.sendFail > 0) {
        seams.sendFail -= 1;
        throw new Error('transport down');
      }
      return { msgId: args.msgId ?? '', msgType: 'msg', receipt: { type: 'receipt' } };
    },
    // The room fan-out, counted so the attested-floor suite can pin the
    // rule: an approval is composed for the OWNER, 1:1, and
    // the fan-out path is never reachable from the ask funnel.
    sendEncryptedFanout: async (): Promise<never> => {
      seams.fanout += 1;
      throw new Error('an approval must never fan into a room');
    },
  };
});

const attendMod = await import('../src/attend.js');
const { attendOnce, loadAttendConfig, realSendReply, saveAttendConfig } = attendMod;
const { MessageLog } = await import('../src/msglog.js');
const { saveProfile } = await import('../src/profile.js');
const { sessionTag } = await import('../src/hooks.js');
const { ApprovalRequestEnvelope } = await import('@tacendum/shared');

const OWNER = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const SESSION_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const OWN_SESSION = 'ffffffff-9999-4999-8999-999999999999';

let seq = 0;
const mid = (): string => `01HQXA00000000000000${String(++seq).padStart(6, '0')}`.slice(0, 26);

function inRow(text: string, opts: { tcm?: string; ref?: string } = {}) {
  return {
    id: mid(),
    dir: 'in' as const,
    peer: OWNER,
    ts: Date.now(),
    tcm: opts.tcm ?? '',
    text,
    read: false,
    ...(opts.ref ? { ref: opts.ref } : {}),
  };
}

async function poll(cond: () => boolean, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('poll timed out');
    await new Promise(r => setTimeout(r, 10));
  }
}

interface JournalRow {
  id: string;
  requestId: string;
  host: string;
  sessionKey?: string;
  payload: string;
  askedAt: number;
  ttlMs: number;
  state: string;
  form?: string;
  msgId?: string;
  decision?: string;
  via?: string;
  answerId?: string;
  spent?: string[];
}
const approvalsFilePath = join(home, 'state', 'bot', 'attend-approvals.json');
const approvalsFile = (): { overCapRefusals: number; rows: JournalRow[] } => {
  try {
    return JSON.parse(readFileSync(approvalsFilePath, 'utf8'));
  } catch {
    return { overCapRefusals: 0, rows: [] };
  }
};
const row0 = (): JournalRow | undefined => approvalsFile().rows[0];
const cursor = (): { lastId?: string } => {
  try {
    return JSON.parse(readFileSync(join(home, 'state', 'bot', 'attend-cursor.json'), 'utf8'));
  } catch {
    return {};
  }
};
const bucketTurns = (): number => {
  try {
    return (
      JSON.parse(readFileSync(join(home, 'state', 'bot', 'attend-bucket.json'), 'utf8')) as {
        turns: number;
      }
    ).turns;
  } catch {
    return 0;
  }
};

/**
 * THE MOVING CLOCK. `now()` reads a fake instant that every `sleep` advances
 * by the requested amount — time moves exactly as it moves in production,
 * only without the waiting, and no test in this file ever pins `now()`
 * beside an advancing timer. The 2ms real delay inside each sleep yields the
 * event loop so a test body can interleave (append an answer row) with a
 * parked pass.
 */
const clockIo = () => {
  let t = Date.now();
  return {
    now: () => t,
    sleep: async (ms: number): Promise<void> => {
      t += ms;
      await new Promise(r => setTimeout(r, 2));
    },
  };
};

/** The reply seam most tests use: records bodies and sessions, returns a
 * minted wire id — the contract `AttendIo.sendReply` documents. */
const fakeSend = () => {
  const bodies: string[] = [];
  const sessions: (OutSess | undefined)[] = [];
  return {
    bodies,
    sessions,
    sendReply: async (b: string, sess?: OutSess): Promise<string> => {
      bodies.push(b);
      sessions.push(sess);
      return mid();
    },
  };
};

/**
 * THE FAKE APPROVING DRIVER — the one thing the shipped drivers cannot be.
 * It asks once through the seam, relays the decision into its stdout (so the
 * reply funnel proves the round trip), and runs any later turn plainly so
 * multi-pass tests do not park forever. `after` is the crash lever: a driver
 * that dies between the decision and its own exit is journal boundary 3↔4.
 */
const approvingDriver = (opts: {
  payload: string;
  ttlMs?: number;
  after?: (d: ApprovalDecision) => Promise<void> | void;
}) => {
  const decisions: ApprovalDecision[] = [];
  let calls = 0;
  const driver: HostDriver = {
    host: 'claude',
    async runTurn(req: TurnRequest) {
      calls += 1;
      if (calls > 1 || req.ask === undefined) {
        return { stdout: 'plain turn', stderr: '', code: 0, refusal: null };
      }
      const ask: ApprovalAsk = {
        payload: opts.payload,
        ...(opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
      };
      const d = await req.ask(ask);
      decisions.push(d);
      await opts.after?.(d);
      return { stdout: `decision:${d}`, stderr: '', code: 0, refusal: null };
    },
  };
  return { driver, decisions, calls: () => calls };
};

beforeEach(() => {
  rmSync(join(home, 'bot'), { recursive: true, force: true });
  rmSync(join(home, 'state'), { recursive: true, force: true });
  seq = 0;
  seams.driver = null;
  seams.sendCalls.length = 0;
  seams.sendFail = 0;
  seams.fanout = 0;
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

describe('the round trip', () => {
  it('request → reply → decision through the real spool, the real ledger row and the real turn lock', async () => {
    new MessageLog('bot').append(inRow('build it please'));
    const fake = approvingDriver({ payload: 'make build', ttlMs: 3_600_000 });
    seams.driver = fake.driver;
    const io = clockIo();

    // No sendReply seam: the card and every reply ride realSendReply, whose
    // transport is the mocked socket and whose LEDGER ROW is real.
    const run = attendOnce('bot', io);
    await poll(() => row0()?.state === 'pending' && row0()?.msgId !== undefined);

    // Write order, observed mid-flight: the row is `pending`, its payload is
    // the exact bytes, its requestId is minted, and the file is 0600.
    const parked = row0() as JournalRow;
    expect(parked.payload).toBe('make build');
    expect(parked.requestId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(statSync(approvalsFilePath).mode & 0o777).toBe(0o600);

    // The parked pass HOLDS the account turn lock: a sibling stands down.
    expect(await attendOnce('bot', io)).toBe('busy');

    // The card left through the one funnel: composed by attend, payload
    // quoted verbatim, and the outbound ledger row carries its msgId — the
    // row that makes the phone's reply-ref resolve at all.
    const card = seams.sendCalls[0];
    expect(card?.body).toContain('make build');
    expect(card?.body).toContain('reply approve or deny');
    const out = new MessageLog('bot').read({ dir: 'out' });
    expect(
      out.some(r => r.id === parked.msgId),
      'realSendReply must write the dir:out ledger row',
    ).toBe(true);

    // The answer is an ORDINARY reply — tcm:'reply', ref = the card's msgId.
    new MessageLog('bot').append(inRow('Approve', { tcm: 'reply', ref: parked.msgId as string }));
    expect(await run).toBe('answered');
    expect(fake.decisions).toEqual(['approve']);

    const settled = row0() as JournalRow;
    expect(settled.state).toBe('done');
    expect(settled.decision).toBe('approve');
    expect(settled.via).toBe('reply');
    expect(settled.payload, 'the stored payload is never rewritten').toBe('make build');
    expect(seams.sendCalls.at(-1)?.body).toBe('decision:approve');

    // The consumed answer row is stepped over on a later pass — no reply, no
    // turn — and then the account is quiet.
    const sends = seams.sendCalls.length;
    expect(await attendOnce('bot', io)).toBe('stepped');
    expect(seams.sendCalls.length, 'stepping over a consumed answer sends nothing').toBe(sends);
    expect(await attendOnce('bot', io)).toBe('idle');
  }, 30_000);

  it('a reply to an ordinary attend answer now routes to its session — the route that was always ended', async () => {
    new MessageLog('bot').append(inRow('hello'));
    const turns: string[][] = [];
    const io = {
      ...clockIo(),
      runTurn: async (argv: string[]) => {
        turns.push(argv);
        return { stdout: 'answered you', code: 0 };
      },
    };
    expect(await attendOnce('bot', io)).toBe('answered');
    // The own turn's reply wrote a ledger row carrying the own session.
    const sent = new MessageLog('bot').read({ dir: 'out' }).find(r => r.sess?.key === OWN_SESSION);
    expect(sent, "attend's own reply must be a routable ledger row").toBeDefined();

    new MessageLog('bot').append(inRow('and now continue', { tcm: 'reply', ref: sent?.id as string }));
    expect(await attendOnce('bot', io)).toBe('answered');
    expect(
      turns[1]?.join(' '),
      'the reply must resume the session the answer spoke for, not route to ended',
    ).toContain(`--resume=${OWN_SESSION}`);
  }, 30_000);
});

describe('the cursor rule', () => {
  it('an ordinary message arriving between request and answer is never skipped — the cursor file is the proof', async () => {
    const log = new MessageLog('bot');
    const p0 = inRow('start the deploy');
    log.append(p0);
    const fake = approvingDriver({ payload: 'deploy now', ttlMs: 3_600_000 });
    seams.driver = fake.driver;
    const h = fakeSend();
    const io = { ...clockIo(), sendReply: h.sendReply };

    const run = attendOnce('bot', io);
    await poll(() => row0()?.state === 'pending');

    // While the pass is parked: an ordinary message, THEN the answer.
    const ordinary = inRow('also update the docs');
    log.append(ordinary);
    const answer = inRow('approve', { tcm: 'reply', ref: row0()?.msgId as string });
    log.append(answer);

    expect(await run).toBe('answered');
    expect(fake.decisions).toEqual(['approve']);
    // THE ASSERTION THE DESIGN DEMANDS, on the cursor file and not the reply:
    // the pass advanced only to the row it actually covered. A naive advance
    // to the consumed answer would have skipped `ordinary` forever, silently.
    expect(cursor().lastId).toBe(p0.id);

    // The next pass answers the ordinary message as its own turn…
    expect(await attendOnce('bot', io)).toBe('answered');
    expect(cursor().lastId).toBe(ordinary.id);

    // …and the consumed answer is then stepped over like a spent journal:
    // no reply, no turn, cursor moved past it.
    const sends = h.bodies.length;
    expect(await attendOnce('bot', io)).toBe('stepped');
    expect(cursor().lastId).toBe(answer.id);
    expect(h.bodies.length).toBe(sends);
    expect(await attendOnce('bot', io)).toBe('idle');
  }, 30_000);
});

describe('crash at each journal boundary', () => {
  /** Crash between write 1 (asking) and write 2: the send itself dies. */
  it('boundary 1↔2: a crash before the card leaves lapses the row and tells the operator once', async () => {
    new MessageLog('bot').append(inRow('go'));
    const fake = approvingDriver({ payload: 'rm -rf ./build', ttlMs: 3_600_000 });
    seams.driver = fake.driver;
    const dying = {
      ...clockIo(),
      sendReply: async (): Promise<string> => {
        throw new Error('SIGKILL before the card left');
      },
    };
    await expect(attendOnce('bot', dying)).rejects.toThrow('SIGKILL');
    // The journal was written BEFORE the send — that order is the contract.
    expect(row0()?.state).toBe('asking');
    expect(row0()?.msgId).toBeUndefined();

    const h = fakeSend();
    const io = { ...clockIo(), sendReply: h.sendReply };
    expect(await attendOnce('bot', io)).toBe('interrupted');
    expect(row0()?.state, 'restart lapses every in-flight row').toBe('lapsed');
    const told = h.bodies.filter(b => b.includes('while attend was restarting'));
    expect(told, 'the operator is told exactly once').toHaveLength(1);

    // Once means once: a later pass finds nothing in flight and says nothing.
    expect(await attendOnce('bot', io)).toBe('idle');
    expect(h.bodies.filter(b => b.includes('while attend was restarting'))).toHaveLength(1);
  }, 30_000);

  /** Crash between write 2 (pending) and write 3: dead mid-park. */
  it('boundary 2↔3: a crash while parked lapses the pending row and burns the id', async () => {
    new MessageLog('bot').append(inRow('go'));
    const fake = approvingDriver({ payload: 'npm publish', ttlMs: 3_600_000 });
    seams.driver = fake.driver;
    const h0 = fakeSend();
    const io0 = {
      now: clockIo().now,
      sendReply: h0.sendReply,
      sleep: async (): Promise<void> => {
        throw new Error('SIGKILL mid-park');
      },
    };
    await expect(attendOnce('bot', io0)).rejects.toThrow('SIGKILL');
    expect(row0()?.state).toBe('pending');
    expect(row0()?.msgId, 'the card DID leave — a phone is holding it').toBeDefined();

    const h = fakeSend();
    const io = { ...clockIo(), sendReply: h.sendReply };
    expect(await attendOnce('bot', io)).toBe('interrupted');
    expect(row0()?.state).toBe('lapsed');
    expect(h.bodies.filter(b => b.includes('while attend was restarting'))).toHaveLength(1);
  }, 30_000);

  /** Crash between write 3 (answering) and write 4: the host never acked. */
  it('boundary 3↔4: a crash after the decision but before the host acked lapses, not re-binds', async () => {
    new MessageLog('bot').append(inRow('go'));
    const fake = approvingDriver({
      payload: 'git push --force',
      ttlMs: 3_600_000,
      after: () => {
        throw new Error('SIGKILL between decision and host ack');
      },
    });
    seams.driver = fake.driver;
    const h0 = fakeSend();
    const io0 = { ...clockIo(), sendReply: h0.sendReply };
    const run = attendOnce('bot', io0);
    await poll(() => row0()?.state === 'pending');
    new MessageLog('bot').append(inRow('approve', { tcm: 'reply', ref: row0()?.msgId as string }));
    await expect(run).rejects.toThrow('SIGKILL');
    // The decision was journalled BEFORE the host call — boundary 3's whole
    // point: a crash in the gap reads as decided-not-delivered.
    expect(row0()?.state).toBe('answering');
    expect(row0()?.decision).toBe('approve');

    const h = fakeSend();
    const io = { ...clockIo(), sendReply: h.sendReply };
    expect(await attendOnce('bot', io)).toBe('interrupted');
    expect(row0()?.state).toBe('lapsed');
    expect(h.bodies.filter(b => b.includes('while attend was restarting'))).toHaveLength(1);
  }, 30_000);
});

describe('a burned id', () => {
  it('a reply naming a burned id is answered honestly and starts no turn', async () => {
    // The 2↔3 crash shape: card delivered, pass dead, restart burned the id.
    new MessageLog('bot').append(inRow('go'));
    const fake = approvingDriver({ payload: 'terraform apply', ttlMs: 3_600_000 });
    seams.driver = fake.driver;
    const h0 = fakeSend();
    await expect(
      attendOnce('bot', {
        now: clockIo().now,
        sendReply: h0.sendReply,
        sleep: async (): Promise<void> => {
          throw new Error('SIGKILL mid-park');
        },
      }),
    ).rejects.toThrow('SIGKILL');
    const burned = row0() as JournalRow;
    expect(burned.state).toBe('pending');

    const h = fakeSend();
    const io = { ...clockIo(), sendReply: h.sendReply };
    expect(await attendOnce('bot', io)).toBe('interrupted');
    expect(row0()?.state).toBe('lapsed');
    const turnsBefore = fake.calls();
    const tokensBefore = bucketTurns();

    // The late answer, naming the burned id.
    new MessageLog('bot').append(inRow('approve', { tcm: 'reply', ref: burned.msgId as string }));
    expect(await attendOnce('bot', io)).toBe('approval-stale');
    expect(
      h.bodies.at(-1),
      'the late answer is answered honestly — the approval lapsed',
    ).toMatch(/approval lapsed/);
    expect(fake.calls(), 'a burned id must never start a turn').toBe(turnsBefore);
    expect(bucketTurns(), 'and must never spend a budget token').toBe(tokensBefore);
    expect(row0()?.state, 'and is never re-bound').toBe('lapsed');
    expect(row0()?.decision).toBeUndefined();
  }, 30_000);
});

describe('TTL', () => {
  it('expiry denies the host, replies to the operator, and settles the row — moving clock', async () => {
    new MessageLog('bot').append(inRow('risky thing'));
    const fake = approvingDriver({ payload: 'drop the table', ttlMs: 60_000 });
    seams.driver = fake.driver;
    const h = fakeSend();
    const io = { ...clockIo(), sendReply: h.sendReply };

    // Nobody answers; the clock moves 2 s per poll until the deadline.
    expect(await attendOnce('bot', io)).toBe('answered');
    expect(fake.decisions, 'expiry is a DENY, never a silent unpark').toEqual(['deny']);
    const row = row0() as JournalRow;
    expect(row.state).toBe('done');
    expect(row.via).toBe('ttl');
    expect(row.decision).toBe('deny');
    expect(
      h.bodies.some(b => b.includes('expired') && b.includes('denied')),
      'the operator is told the approval expired and was denied',
    ).toBe(true);
  }, 30_000);

  it('the TTL is clamped to the stated floor — a shorter ask cannot make a card unanswerable from a phone', async () => {
    new MessageLog('bot').append(inRow('quick one'));
    const fake = approvingDriver({ payload: 'true', ttlMs: 5_000 });
    seams.driver = fake.driver;
    const h = fakeSend();
    const io = { ...clockIo(), sendReply: h.sendReply };
    expect(await attendOnce('bot', io)).toBe('answered');
    expect(row0()?.ttlMs).toBe(attendMod.APPROVAL_TTL_MIN_MS);
  }, 30_000);
});

describe('the verbs', () => {
  it('approve/deny: exact, case-insensitive, whole-message; anything else re-asks once and consumes nothing', async () => {
    new MessageLog('bot').append(inRow('do it'));
    const fake = approvingDriver({ payload: 'run migration', ttlMs: 3_600_000 });
    seams.driver = fake.driver;
    const h = fakeSend();
    const io = { ...clockIo(), sendReply: h.sendReply };
    const run = attendOnce('bot', io);
    await poll(() => row0()?.state === 'pending');
    const msgId = row0()?.msgId as string;

    // An unrecognised verb: one honest re-ask, approval untouched.
    new MessageLog('bot').append(inRow('yes', { tcm: 'reply', ref: msgId }));
    await poll(() => h.bodies.some(b => b.includes('Reply approve or deny')));
    expect(row0()?.state, 'an unrecognised verb consumes nothing of the approval').toBe('pending');

    // A NEAR MISS is not a verb — whole-message or nothing — and the second
    // junk answer buys no second re-ask. Then a shouted, padded deny lands.
    new MessageLog('bot').append(inRow('approve it', { tcm: 'reply', ref: msgId }));
    new MessageLog('bot').append(inRow('  DENY  ', { tcm: 'reply', ref: msgId }));
    expect(await run).toBe('answered');
    expect(fake.decisions).toEqual(['deny']);
    expect(
      h.bodies.filter(b => b.includes('Reply approve or deny')),
      'one honest re-ask, not a nag loop',
    ).toHaveLength(1);

    // Every consumed row — the junk and the decider — is stepped over later.
    expect(await attendOnce('bot', io)).toBe('stepped');
    expect(await attendOnce('bot', io)).toBe('idle');
  }, 30_000);

  it('a second answer after settlement is told so, and changes nothing', async () => {
    new MessageLog('bot').append(inRow('do it'));
    const fake = approvingDriver({ payload: 'make release', ttlMs: 3_600_000 });
    seams.driver = fake.driver;
    const h = fakeSend();
    const io = { ...clockIo(), sendReply: h.sendReply };
    const run = attendOnce('bot', io);
    await poll(() => row0()?.state === 'pending');
    const msgId = row0()?.msgId as string;
    new MessageLog('bot').append(inRow('approve', { tcm: 'reply', ref: msgId }));
    expect(await run).toBe('answered');
    expect(fake.decisions).toEqual(['approve']);

    // The losing answer arrives after settlement.
    expect(await attendOnce('bot', io)).toBe('stepped');
    new MessageLog('bot').append(inRow('deny', { tcm: 'reply', ref: msgId }));
    expect(await attendOnce('bot', io)).toBe('approval-stale');
    expect(h.bodies.at(-1)).toMatch(/already answered/);
    expect(row0()?.decision, 'first writer won and stays won').toBe('approve');
  }, 30_000);
});

describe('the over-cap refusal', () => {
  it('an over-cap payload refuses one-tap, names the size, denies, and is counted (C11)', async () => {
    new MessageLog('bot').append(inRow('go'));
    const fake = approvingDriver({ payload: 'x'.repeat(400) });
    seams.driver = fake.driver;
    const h = fakeSend();
    const io = { ...clockIo(), sendReply: h.sendReply };
    expect(await attendOnce('bot', io)).toBe('answered');
    expect(fake.decisions, 'unshown is unapprovable: the host hears deny').toEqual(['deny']);

    const refusal = h.bodies.find(b => b.includes('400-character'));
    expect(refusal, 'the refusal names the size').toBeDefined();
    expect(refusal).toContain('280');
    expect(refusal, 'never truncated: no payload bytes ride the refusal').not.toContain('xxxx');
    expect(
      h.bodies.some(b => b.includes('Approval needed')),
      'no card was sent — the refusal replaced it',
    ).toBe(false);
    expect(approvalsFile().overCapRefusals, "C11's counter").toBe(1);
    const row = row0() as JournalRow;
    expect(row.state).toBe('done');
    expect(row.via).toBe('overcap');
  }, 30_000);

  it('a payload the chat rendering would alter is refused too — verbatim or nothing', async () => {
    new MessageLog('bot').append(inRow('go'));
    // Short, but plainForChat strips the backticks: what the phone showed
    // would not be the bytes the host executes.
    const fake = approvingDriver({ payload: 'echo `whoami`' });
    seams.driver = fake.driver;
    const h = fakeSend();
    const io = { ...clockIo(), sendReply: h.sendReply };
    expect(await attendOnce('bot', io)).toBe('answered');
    expect(fake.decisions).toEqual(['deny']);
    expect(h.bodies.some(b => b.includes('Approval needed'))).toBe(false);
    expect(approvalsFile().overCapRefusals).toBe(1);
  }, 30_000);
});

describe('the outbound ledger row', () => {
  it('realSendReply writes the hook-shaped dir:out row and returns the wire id', async () => {
    const sess = { host: 'claude', key: SESSION_A, tag: 's-a1b2' };
    const id = await realSendReply('bot', 'hello there', sess);
    expect(seams.sendCalls.at(-1)?.msgId, 'the wire carried the minted id').toBe(id);
    const row = new MessageLog('bot').read({ dir: 'out' }).find(r => r.id === id);
    expect(row).toBeDefined();
    expect(row?.read, "the machine's own send never pollutes the unread count").toBe(true);
    expect(row?.text, 'no third plaintext copy — the ledger routes, it does not remember').toBe('');
    expect(row?.sess?.key).toBe(SESSION_A);
  });

  it('a failed send rides the notify queue with the SAME msgId and sess, so the retry writes the same row', async () => {
    seams.sendFail = 1;
    const sess = { host: 'claude', key: SESSION_A, tag: 's-a1b2' };
    const id = await realSendReply('bot', 'hello', sess);
    expect(
      new MessageLog('bot').read({ dir: 'out' }).some(r => r.id === id),
      'no ledger row until delivery — the flusher writes it when the retry lands',
    ).toBe(false);
    const dir = join(home, 'state', 'bot', 'notify-queue');
    const entries = readdirSync(dir).filter(n => n.endsWith('.json'));
    expect(entries).toHaveLength(1);
    const entry = JSON.parse(readFileSync(join(dir, entries[0] as string), 'utf8')) as {
      msgId: string;
      sess?: { key?: string };
    };
    expect(entry.msgId, "the queue entry carries the reply's own wire id").toBe(id);
    expect(entry.sess?.key).toBe(SESSION_A);
  });
});

describe('the seam stays optional', () => {
  it('a config-driven pass with no approving driver behaves exactly as before', async () => {
    // No fake driver: the REAL claude driver runs through the fake spawn —
    // proof that adding `ask` changed no existing shape.
    new MessageLog('bot').append(inRow('hello'));
    const turns: string[][] = [];
    const io = {
      ...clockIo(),
      sendReply: fakeSend().sendReply,
      runTurn: async (argv: string[]) => {
        turns.push(argv);
        return { stdout: 'done: shipped', code: 0 };
      },
    };
    expect(await attendOnce('bot', io)).toBe('answered');
    expect(turns).toHaveLength(1);
    expect(loadAttendConfig('bot')?.ownSessionStarted).toBe(true);
    expect(approvalsFile().rows, 'no approval was asked, none was journalled').toHaveLength(0);
  }, 30_000);
});

/**
 * ---------------------------------------------------------------------------
 * THE VERBS — `edit:` and `respond:` — against the measured protocol:
 * codex's decision enum admits no substitute command and no text on any
 * decision (the vendored-type note in codex-appserver.ts), so `edit:`
 * supersedes-and-denies and `respond:` denies-and-steers through the spool.
 * Both are proven here on the supervisor, where the journal and the verbs
 * live.
 * ---------------------------------------------------------------------------
 */

/** A driver that asks ONCE with a stated kind (and optionally the thread key
 * it already knows), then records every later turn's prompt and route — the
 * shape the respond tests need to see the guidance arrive as a prompt. */
const askingDriver = (opts: {
  payload: string;
  kind?: 'commandExecution' | 'fileChange';
  sessionKey?: string;
  host?: 'claude' | 'codex';
}) => {
  const decisions: ApprovalDecision[] = [];
  const later: { prompt: string; route: TurnRequest['route'] }[] = [];
  let calls = 0;
  const driver: HostDriver = {
    host: opts.host ?? 'claude',
    async runTurn(req: TurnRequest) {
      calls += 1;
      if (calls > 1 || req.ask === undefined) {
        later.push({ prompt: req.prompt, route: req.route });
        return { stdout: 'plain turn', stderr: '', code: 0, refusal: null };
      }
      const d = await req.ask({
        payload: opts.payload,
        ttlMs: 3_600_000,
        ...(opts.kind !== undefined ? { kind: opts.kind } : {}),
        ...(opts.sessionKey !== undefined ? { sessionKey: opts.sessionKey } : {}),
      });
      decisions.push(d);
      return { stdout: `decision:${d}`, stderr: '', code: 0, refusal: null };
    },
  };
  return { driver, decisions, later, calls: () => calls };
};

describe('the edit verb', () => {
  it('edit: supersedes the request — denied on the wire, the journal names the displacement, and the operator is told the edited bytes did NOT run', async () => {
    new MessageLog('bot').append(inRow('deploy it'));
    const fake = askingDriver({ payload: 'make deploy', kind: 'commandExecution' });
    seams.driver = fake.driver;
    const h = fakeSend();
    const io = { ...clockIo(), sendReply: h.sendReply };
    const run = attendOnce('bot', io);
    await poll(() => row0()?.state === 'pending');

    new MessageLog('bot').append(
      inRow('edit: make deploy TARGET=staging', { tcm: 'reply', ref: row0()?.msgId as string }),
    );
    expect(await run).toBe('answered');
    // The HOST heard a plain deny — all the measured wire admits.
    expect(fake.decisions).toEqual(['deny']);
    // The JOURNAL says what actually happened, and the id is burned with it.
    const row = row0() as JournalRow;
    expect(row.state, "an edit's terminal state is named, never overloaded onto done").toBe(
      'superseded',
    );
    expect(row.via).toBe('edit');
    expect(row.decision).toBe('deny');
    expect(row.payload, 'the stored payload is never rewritten — not even by an edit').toBe(
      'make deploy',
    );
    // The operator was told the edited command was NOT run, and why.
    const told = h.bodies.find(b => b.includes('superseded'));
    expect(told).toBeDefined();
    expect(told).toContain('NOT run');
    expect(told, 'the edited bytes are never echoed back').not.toContain('TARGET=staging');
  }, 30_000);

  it("a burned superseded id approves nothing — the non-vacuity of the edit's burn", async () => {
    new MessageLog('bot').append(inRow('deploy it'));
    const fake = askingDriver({ payload: 'make deploy', kind: 'commandExecution' });
    seams.driver = fake.driver;
    const h = fakeSend();
    const io = { ...clockIo(), sendReply: h.sendReply };
    const run = attendOnce('bot', io);
    await poll(() => row0()?.state === 'pending');
    const cardId = row0()?.msgId as string;
    new MessageLog('bot').append(inRow('edit: rm -rf /', { tcm: 'reply', ref: cardId }));
    expect(await run).toBe('answered');
    expect(row0()?.state).toBe('superseded');

    // The consumed edit row is stepped over like any spent answer…
    expect(await attendOnce('bot', io)).toBe('stepped');
    const turnsBefore = fake.calls();
    const tokensBefore = bucketTurns();
    // …and a late `approve` naming the superseded card changes NOTHING:
    // no turn, no token, no re-bind — the original id must not approve
    // anything, ever.
    new MessageLog('bot').append(inRow('approve', { tcm: 'reply', ref: cardId }));
    expect(await attendOnce('bot', io)).toBe('approval-stale');
    expect(h.bodies.at(-1)).toMatch(/superseded/);
    expect(fake.calls(), 'a superseded id must never start a turn').toBe(turnsBefore);
    expect(bucketTurns(), 'and must never spend a budget token').toBe(tokensBefore);
    expect(row0()?.decision, 'the deny stands; nothing was re-bound').toBe('deny');
    expect(row0()?.state).toBe('superseded');
  }, 30_000);

  it('edit: aimed at anything but a command is refused honestly and consumes nothing of the approval', async () => {
    new MessageLog('bot').append(inRow('change the file'));
    const fake = askingDriver({ payload: '--- src/app.ts\n@@ -1 +1 @@', kind: 'fileChange' });
    seams.driver = fake.driver;
    const h = fakeSend();
    const io = { ...clockIo(), sendReply: h.sendReply };
    const run = attendOnce('bot', io);
    await poll(() => row0()?.state === 'pending');
    const cardId = row0()?.msgId as string;

    new MessageLog('bot').append(inRow('edit: something else', { tcm: 'reply', ref: cardId }));
    await poll(() => h.bodies.some(b => b.includes('cannot be edited from a phone')));
    expect(row0()?.state, 'the approval itself is untouched by the refused edit').toBe('pending');

    new MessageLog('bot').append(inRow('deny', { tcm: 'reply', ref: cardId }));
    expect(await run).toBe('answered');
    expect(fake.decisions).toEqual(['deny']);
    expect(row0()?.via, 'the decider was the deny, not the edit').toBe('reply');
  }, 30_000);
});

describe('the respond verb', () => {
  it('respond: denies the approval and the guidance runs as the NEXT pass\'s prompt, routed to the session that asked', async () => {
    new MessageLog('bot').append(inRow('build it'));
    const fake = askingDriver({ payload: 'make build', kind: 'commandExecution' });
    seams.driver = fake.driver;
    const io = clockIo(); // realSendReply: the card's LEDGER ROW must be real
    const run = attendOnce('bot', io);
    await poll(() => row0()?.state === 'pending' && row0()?.msgId !== undefined);

    new MessageLog('bot').append(
      inRow('respond: fix the tests first, then build', {
        tcm: 'reply',
        ref: row0()?.msgId as string,
      }),
    );
    expect(await run).toBe('answered');
    expect(fake.decisions, 'respond approves nothing — the host hears deny').toEqual(['deny']);
    const row = row0() as JournalRow;
    expect(row.state).toBe('done');
    expect(row.via).toBe('respond');

    // The NEXT pass runs the guidance as an ordinary prompt — verb stripped,
    // routed by the card row's session to the thread that asked.
    expect(await attendOnce('bot', io)).toBe('answered');
    expect(fake.later).toHaveLength(1);
    expect(fake.later[0]?.prompt).toBe('fix the tests first, then build');
    expect(fake.later[0]?.route).toEqual({ kind: 'session', host: 'claude', key: OWN_SESSION });
    expect(await attendOnce('bot', io)).toBe('idle');
  }, 30_000);

  it("the card's ledger row carries the key the DRIVER knew mid-turn — a codex thread's respond routes home", async () => {
    // codex-shaped: no turnSess exists up front (an own codex turn), so the
    // ask's own sessionKey is the only way the card row can carry a session.
    const THREAD = 'cccccccc-3333-4333-8333-333333333333';
    saveAttendConfig('bot', {
      host: 'codex', bin: '/opt/agent', workdir: '/w', caps: ['-s', 'read-only'],
      codexDriver: 'app-server', ownSession: OWN_SESSION, turnsPerHour: 10,
    });
    new MessageLog('bot').append(inRow('build it'));
    const fake = askingDriver({
      payload: 'make build', kind: 'commandExecution', sessionKey: THREAD, host: 'codex',
    });
    seams.driver = fake.driver;
    const io = clockIo();
    const run = attendOnce('bot', io);
    await poll(() => row0()?.state === 'pending' && row0()?.msgId !== undefined);
    const cardId = row0()?.msgId as string;
    const cardRow = new MessageLog('bot').read({ dir: 'out' }).find(r => r.id === cardId);
    expect(cardRow?.sess?.key, "the driver's mid-turn key rides the card's ledger row").toBe(
      THREAD,
    );

    new MessageLog('bot').append(inRow('respond: use the staging env', { tcm: 'reply', ref: cardId }));
    expect(await run).toBe('answered');
    expect(await attendOnce('bot', io)).toBe('answered');
    expect(fake.later[0]?.prompt).toBe('use the staging env');
    expect(fake.later[0]?.route).toEqual({ kind: 'session', host: 'codex', key: THREAD });
  }, 30_000);
});

describe('sequential asks within one turn', () => {
  /** A driver that asks N times in a row — the ONLY multiplicity one pass
   * can produce: the pass runs one turn, and each ask parks it, so there is
   * never more than one PENDING approval per account at any moment. What is
   * real is N cards in quick succession. */
  const serialAsker = (payloads: string[]) => {
    const decisions: ApprovalDecision[] = [];
    const driver: HostDriver = {
      host: 'claude',
      async runTurn(req: TurnRequest) {
        if (req.ask === undefined) return { stdout: 'no seam', stderr: '', code: 0, refusal: null };
        for (const payload of payloads) {
          decisions.push(await req.ask({ payload, ttlMs: 3_600_000, kind: 'commandExecution' }));
        }
        return { stdout: 'all asked', stderr: '', code: 0, refusal: null };
      },
    };
    return { driver, decisions };
  };

  it('cards from the second ask on carry the running count, and the fifth send inside a minute carries the hedged wake note', async () => {
    new MessageLog('bot').append(inRow('do five things'));
    const fake = serialAsker(['cmd one', 'cmd two', 'cmd three', 'cmd four', 'cmd five']);
    seams.driver = fake.driver;
    const h = fakeSend();
    const io = { ...clockIo(), sendReply: h.sendReply };
    const run = attendOnce('bot', io);

    // Answer each card as it lands: the asks are SERIAL — the next card can
    // only exist once the previous approval settled.
    for (let k = 1; k <= 5; k += 1) {
      await poll(() => {
        const rows = approvalsFile().rows;
        return rows.length === k && rows[k - 1]?.state === 'pending';
      });
      const card = approvalsFile().rows[k - 1] as JournalRow;
      new MessageLog('bot').append(inRow('approve', { tcm: 'reply', ref: card.msgId as string }));
    }
    expect(await run).toBe('answered');
    expect(fake.decisions).toEqual(['approve', 'approve', 'approve', 'approve', 'approve']);

    const cards = h.bodies.filter(b => b.includes('reply approve or deny'));
    expect(cards).toHaveLength(5);
    expect(cards[0], 'the first ask needs no count').toMatch(/^Approval needed — /);
    expect(cards[1]).toContain('(approval 2 of this turn)');
    expect(cards[3]).toContain('approval 4 of this turn');
    expect(cards[3], 'four sends within the minute is still inside the wake budget').not.toContain(
      'may not have rung',
    );
    // The fifth card is the fifth send inside 60 s of fake time — the wake
    // budget (4/min per pair) is likely spent, and the card says MAY, never
    // a claim: attend cannot read the server-side counter (the heuristic's
    // honesty argument lives on `sentAt` in attend.ts).
    expect(cards[4]).toContain('approval 5 of this turn');
    expect(cards[4]).toContain('may not have rung');
  }, 30_000);

  it('a late answer to a TTL-expired approval is told the deadline beat them — not "already answered"', async () => {
    new MessageLog('bot').append(inRow('slow one'));
    const fake = askingDriver({ payload: 'make slow', kind: 'commandExecution' });
    seams.driver = fake.driver;
    // Re-mint the fake with a short TTL: askingDriver pins 1h, so drive the
    // expiry through the approvingDriver helper instead.
    const short = approvingDriver({ payload: 'make slow', ttlMs: 60_000 });
    seams.driver = short.driver;
    const h = fakeSend();
    const io = { ...clockIo(), sendReply: h.sendReply };
    expect(await attendOnce('bot', io)).toBe('answered');
    expect(short.decisions).toEqual(['deny']);
    const expired = row0() as JournalRow;
    expect(expired.via).toBe('ttl');
    expect(expired.state).toBe('done');

    new MessageLog('bot').append(inRow('approve', { tcm: 'reply', ref: expired.msgId as string }));
    expect(await attendOnce('bot', io)).toBe('approval-stale');
    expect(
      h.bodies.at(-1),
      'the stale answer is told about the DEADLINE, not about some other answerer',
    ).toMatch(/expired before this answer arrived/);
    expect(row0()?.decision, 'nothing was re-bound').toBe('deny');
    expect(fake.calls(), 'no turn ran for the stale answer').toBe(0);
  }, 30_000);
});

/**
 * ---------------------------------------------------------------------------
 * THE ATTESTED FLOOR — the `x.approval` envelope leaves ONLY behind
 * the operator's `attend enable --approvals` attestation, and INSTEAD of the
 * plain prompt, never beside it: the card renders everything the text said,
 * and two messages per ask would spend the wake budget twice and put two
 * answer targets for one authorization on one screen. Un-attested accounts
 * keep the text path forever — it is not transitional. The answer path
 * is UNCHANGED either way: the card's buttons send the ordinary reply-ref
 * reply the parked pass already consumes.
 *
 * The fixture (`packages/shared/approvalvectors.json`) is the cross-client
 * agreement artifact: the emitted envelope is held to the same schema and the
 * same verb conventions the app's card suite parses from the same bytes.
 * ---------------------------------------------------------------------------
 */
const approvalVectors = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../shared/approvalvectors.json', import.meta.url)),
    'utf8',
  ),
) as { cases: { name: string; kind: string; body: string }[] };
const vectorBody = (name: string): Record<string, unknown> => {
  const found = approvalVectors.cases.find(c => c.name === name);
  if (!found) throw new Error(`approvalvectors.json is missing the '${name}' case`);
  return JSON.parse(found.body) as Record<string, unknown>;
};

describe('the attested floor', () => {
  /** The attestation, as enable writes it — the config field is the whole
   * gate, so the tests state it the way an operator's enable run would. */
  const attest = (minAppBuild = 42): void => {
    saveAttendConfig('bot', {
      ...(loadAttendConfig('bot') as NonNullable<ReturnType<typeof loadAttendConfig>>),
      approvalsMinAppBuild: minAppBuild,
    });
  };
  /** Every send whose body IS an x.approval envelope — parsed, not
   * prefix-matched, so a key-order change cannot blind the assertion. */
  const envelopeBodies = (): { to: string; body: string; msgId?: string }[] =>
    seams.sendCalls.filter(c => {
      try {
        return (JSON.parse(c.body) as { tcm?: string }).tcm === 'x.approval';
      } catch {
        return false;
      }
    });

  it('an attested ask emits the schema-valid envelope to the owner 1:1, and the card-built reply is consumed identically to a typed one', async () => {
    attest();
    new MessageLog('bot').append(inRow('build it please'));
    const fake = askingDriver({ payload: 'make build', kind: 'commandExecution' });
    seams.driver = fake.driver;
    const io = clockIo();
    // No sendReply seam: the envelope must ride realSendReply — the wire
    // msgId lands in the journal and the dir:out ledger row is real.
    const run = attendOnce('bot', io);
    await poll(() => row0()?.state === 'pending' && row0()?.msgId !== undefined);

    const parked = row0() as JournalRow;
    expect(parked.form, 'the journal names the form the ask left in').toBe('card');
    // ONE send, and it is the envelope — never a plain-text twin beside it.
    expect(seams.sendCalls).toHaveLength(1);
    expect(seams.sendCalls[0]?.body).not.toContain('Approval needed');
    const wire = seams.sendCalls[0] as { to: string; body: string; msgId?: string };
    // The rooms pin: the owner, 1:1, and the
    // fan-out path untouched.
    expect(wire.to, 'an approval is composed for the OWNER, never a room').toBe(OWNER);
    expect(seams.fanout, 'the room fan-out path is never reached').toBe(0);

    const parsed = ApprovalRequestEnvelope.safeParse(JSON.parse(wire.body));
    expect(parsed.success, 'the emitted body is a valid shared-schema envelope').toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.q, 'q is THE binding — the journal row requestId').toBe(parked.requestId);
    expect(parsed.data.p, 'the payload rides verbatim').toBe('make build');
    expect(parsed.data.k).toBe('exec');
    expect(parsed.data.x, "the clamped TTL, in the wire's seconds").toBe(3600);
    expect(parsed.data.s, 'the tag, never the raw key').toBe(sessionTag(OWN_SESSION));
    expect(parsed.data.a, "the fixture's verb conventions, exactly").toEqual(
      vectorBody('request').a,
    );
    // The wire msgId is the journal's reply-ref target, and its ledger row
    // is what routes the phone's answer.
    expect(wire.msgId).toBe(parked.msgId);
    expect(new MessageLog('bot').read({ dir: 'out' }).some(r => r.id === parked.msgId)).toBe(true);

    // THE ANSWER PATH IS UNCHANGED: the reply below is built exactly as the
    // app's card buttons will build it — {tcm:'reply', ref: the card's wire
    // msgId, text: a verb from the request's own `a`} — and is consumed by
    // the same park loop a typed reply reaches.
    const verb = (vectorBody('request').a as string[])[0] as string;
    new MessageLog('bot').append(inRow(verb, { tcm: 'reply', ref: parked.msgId as string }));
    expect(await run).toBe('answered');
    expect(fake.decisions).toEqual(['approve']);
    expect(row0()?.state).toBe('done');
    expect(row0()?.via).toBe('reply');
  }, 30_000);

  it('an un-attested account keeps the plain-text path — no envelope ever leaves', async () => {
    // NO attestation: the beforeEach config carries none, and that absence
    // is permanent, not transitional — this is the test the non-vacuity
    // check breaks by forcing the gate open.
    new MessageLog('bot').append(inRow('build it please'));
    const fake = askingDriver({ payload: 'make build', kind: 'commandExecution' });
    seams.driver = fake.driver;
    const io = clockIo();
    const run = attendOnce('bot', io);
    await poll(() => row0()?.state === 'pending' && row0()?.msgId !== undefined);

    expect(row0()?.form).toBe('text');
    expect(seams.sendCalls[0]?.body).toContain('Approval needed');
    expect(seams.sendCalls[0]?.body).toContain('reply approve or deny');
    expect(envelopeBodies(), 'the x.approval envelope must NEVER leave un-attested').toHaveLength(0);

    new MessageLog('bot').append(inRow('deny', { tcm: 'reply', ref: row0()?.msgId as string }));
    expect(await run).toBe('answered');
    expect(fake.decisions).toEqual(['deny']);
    expect(envelopeBodies()).toHaveLength(0);
  }, 30_000);

  it("the card's cap is the schema's, not the funnel's: a payload the chat funnel refuses rides the card verbatim", async () => {
    attest();
    // Over 280 chars AND backtick-laden — the TEXT form refuses exactly this
    // (the funnel would clip and alter it); the falsifiability control that
    // proves the two caps genuinely differ.
    const payload = 'echo `whoami` && ' + 'x'.repeat(400);
    new MessageLog('bot').append(inRow('go'));
    const fake = askingDriver({ payload, kind: 'commandExecution' });
    seams.driver = fake.driver;
    const io = clockIo();
    const run = attendOnce('bot', io);
    await poll(() => row0()?.state === 'pending' && row0()?.msgId !== undefined);

    expect(approvalsFile().overCapRefusals, 'no refusal — the card carries it').toBe(0);
    const env = JSON.parse((envelopeBodies()[0] as { body: string }).body) as { p: string };
    expect(env.p, 'verbatim — the card form never funnels').toBe(payload);

    new MessageLog('bot').append(inRow('deny', { tcm: 'reply', ref: row0()?.msgId as string }));
    expect(await run).toBe('answered');
  }, 30_000);

  it('past MAX_APPROVAL_PAYLOAD_BYTES the card refuses one-tap exactly as today — instant deny, counted, and the refusal names ITS cap', async () => {
    attest();
    new MessageLog('bot').append(inRow('go'));
    const fake = askingDriver({ payload: 'x'.repeat(16 * 1024 + 1), kind: 'commandExecution' });
    seams.driver = fake.driver;
    const io = clockIo();
    expect(await attendOnce('bot', io)).toBe('answered');
    expect(fake.decisions, 'unshown is unapprovable, attested or not').toEqual(['deny']);
    expect(approvalsFile().overCapRefusals, "C11's counter").toBe(1);
    expect(row0()?.via).toBe('overcap');
    expect(row0()?.form).toBe('card');
    expect(envelopeBodies(), 'no envelope left').toHaveLength(0);
    const refusal = seams.sendCalls.map(c => c.body).find(b => b.includes('approval card'));
    expect(refusal, "the refusal names the CARD's cap, not the text funnel's").toBeDefined();
    expect(refusal).toContain(String(16 * 1024));
    expect(refusal, 'the size, never the bytes').not.toContain('xxxx');
  }, 30_000);

  it("a card's expiry names the older-build possibility — the TTL deny is the only signal an attested-but-old phone gets", async () => {
    attest();
    new MessageLog('bot').append(inRow('risky thing'));
    const fake = approvingDriver({ payload: 'drop the table', ttlMs: 60_000 });
    seams.driver = fake.driver;
    const io = clockIo(); // the moving clock walks past the deadline
    expect(await attendOnce('bot', io)).toBe('answered');
    expect(fake.decisions).toEqual(['deny']);
    expect(row0()?.via).toBe('ttl');
    expect(row0()?.form).toBe('card');
    const said = seams.sendCalls.map(c => c.body).find(b => b.includes('expired'));
    expect(said, 'the expiry sentence exists in plain text every build renders').toBeDefined();
    expect(said, 'and carries the diagnosis: an older app build than attested').toContain(
      'older app build than attested',
    );
    expect(said).toContain('--approvals');
  }, 30_000);

  it("sequential attested asks carry the running count as the envelope's n — absent on the first", async () => {
    attest();
    new MessageLog('bot').append(inRow('do two things'));
    const decisions: ApprovalDecision[] = [];
    const driver: HostDriver = {
      host: 'claude',
      async runTurn(req: TurnRequest) {
        if (req.ask === undefined) return { stdout: 'no seam', stderr: '', code: 0, refusal: null };
        for (const payload of ['cmd one', 'cmd two']) {
          decisions.push(await req.ask({ payload, ttlMs: 3_600_000, kind: 'commandExecution' }));
        }
        return { stdout: 'all asked', stderr: '', code: 0, refusal: null };
      },
    };
    seams.driver = driver;
    const io = clockIo();
    const run = attendOnce('bot', io);
    for (let k = 1; k <= 2; k += 1) {
      await poll(() => {
        const rows = approvalsFile().rows;
        return rows.length === k && rows[k - 1]?.state === 'pending';
      });
      const card = approvalsFile().rows[k - 1] as JournalRow;
      new MessageLog('bot').append(inRow('approve', { tcm: 'reply', ref: card.msgId as string }));
    }
    expect(await run).toBe('answered');
    expect(decisions).toEqual(['approve', 'approve']);
    const envs = envelopeBodies().map(c => JSON.parse(c.body) as { n?: number });
    expect(envs).toHaveLength(2);
    expect(envs[0]?.n, 'the first ask needs no count').toBeUndefined();
    expect(envs[1]?.n, "the running count rides the wire's own field").toBe(2);
  }, 30_000);

  it('a lapsed card is named a CARD by the restart sentence — the journal form decides the noun', async () => {
    attest();
    new MessageLog('bot').append(inRow('go'));
    const fake = askingDriver({ payload: 'make x', kind: 'commandExecution' });
    seams.driver = fake.driver;
    await expect(
      attendOnce('bot', {
        now: clockIo().now,
        sleep: async (): Promise<void> => {
          throw new Error('SIGKILL mid-park');
        },
      }),
    ).rejects.toThrow('SIGKILL');
    expect(row0()?.state).toBe('pending');
    expect(row0()?.form).toBe('card');

    const h = fakeSend();
    const io = { ...clockIo(), sendReply: h.sendReply };
    expect(await attendOnce('bot', io)).toBe('interrupted');
    expect(row0()?.state).toBe('lapsed');
    expect(h.bodies.find(b => b.includes('while attend was restarting'))).toContain(
      'approval card',
    );
  }, 30_000);
});

/**
 * THE ROOMS PIN, TIGHTENED BY THE CONSENT REMEDIATION. The
 * original pin was "approvals from a room-routed turn stay 1:1 to the
 * owner" — an ask was still POSSIBLE, just never composed into the room.
 * the completed form is stricter: a room turn carries NO approval
 * capability at all — the driver is spawned WITHOUT the ask funnel (and,
 * for codex, with the approval policy floored to 'never'), so no card is
 * minted anywhere, 1:1 included. The room path still carries ONLY the
 * final answer; the never-into-a-room property survives as a corollary of
 * there being no ask to compose.
 */
describe('a room-routed turn carries no approval capability', () => {
  const GID = '01GRPAAAAAAAAAAAAAAAAAAAAA';

  it('the driver receives no ask funnel; no card is minted 1:1 or into the room; the answer alone enters the room', async () => {
    new MessageLog('bot').append({
      id: mid(), dir: 'in', peer: OWNER, ts: Date.now(), tcm: 'grp.msg',
      text: '[crew] @you deploy it', read: false, grp: GID, men: true,
    });
    const asks: unknown[] = [];
    seams.driver = {
      host: 'claude',
      async runTurn(req) {
        asks.push(req.ask);
        return { stdout: 'decision:done', stderr: '', code: 0, refusal: null };
      },
    };
    const roomReplies: { gid: string; body: string }[] = [];
    const io = {
      ...clockIo(),
      sendRoomReply: async (gid: string, body: string) => {
        roomReplies.push({ gid, body });
        return { m: mid(), delivered: [OWNER], skipped: [], failed: [] };
      },
    };
    expect(await attendOnce('bot', io)).toBe('answered');
    expect(asks, 'the ask funnel is withheld from a room spawn').toEqual([undefined]);
    expect(row0(), 'no approval row was ever minted').toBeUndefined();
    expect(
      seams.sendCalls.filter(c => (c as { body: string }).body.includes('Approval needed')),
      'no card left 1:1 either — there is no ask to compose',
    ).toHaveLength(0);
    expect(seams.fanout, 'the room fan-out path is never reached by an ask').toBe(0);
    expect(roomReplies, 'the final answer — and only it — enters the room').toHaveLength(1);
    expect(roomReplies[0]?.gid).toBe(GID);
    expect(roomReplies[0]?.body).toBe('decision:done');
  }, 30_000);
});
