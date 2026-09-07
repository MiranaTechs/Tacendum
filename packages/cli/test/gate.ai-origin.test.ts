import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE ART. 50 AI-ORIGIN FUNNEL — one module, one rule: every agent-authored body
 * leaves marked, and no compose path escapes.
 *
 * What this file pins, red-first where the design names a mutation:
 *
 *  1. `markAgentBody` — envelope bodies gain `"ai":true` with `tcm` still
 *     serialized first (parseEnvelope routes on the literal prefix); bare
 *     text wraps into the `msg` kind ONLY under the operator's app-build
 *     attestation (a new conversational kind renders "Unsupported message"
 *     on every pre-marker build — the `--stream` posture, exactly);
 *     marking never throws and never costs a message.
 *  2. THE ONE WAY OUT IS MARKED: a full attested attend turn — approval
 *     card, anchor, stream intermediates, durable final — leaves NOTHING
 *     unmarked on the reply seam or the edit channel (mutation: drop the
 *     markAgentBody call in attendPass's send wrapper and this goes red).
 *  3. UN-ATTESTED IS TODAY for bare text, byte-identical — while envelope
 *     bodies (the edit final, the card) are marked regardless, because a
 *     KNOWN kind carrying an unknown field is invisible to every shipped
 *     parser (strip mode; a measured compatibility fact).
 *  4. THE ROOM WRAPPER: an
 *     agent-authored room reply rides `grp.msg` with `ai:true` ON THE
 *     WRAPPER — and when `b` is itself an envelope (reply/mention/msg —
 *     strip-mode parsers, zero compat cost) `ai` is ALSO set inside it, so
 *     the claim survives a grp.hist relay of the bare `b` bytes. Bare-text
 *     `b` stays bare — a pre-marker stranger's build still renders the
 *     words (mutations, both directions: drop the wrapper `ai` → red; drop
 *     the inner `ai` → red).
 *  5. The hook/notify lane marks through the SAME funnel, gated by the SAME
 *     attestation file — and ONLY for the owner: the attestation speaks for
 *     the owner's phone alone, so a `--to` send stays byte-bare.
 *  6. `attend enable --marker` writes the attestation, refuses a malformed
 *     shape, and reads the claim back — ONE paragraph, shared verbatim by
 *     both host branches, and the ungated envelope-arm marking is disclosed
 *     even without the flag.
 *  7. The compose-time approval-card cap guard sees the FINAL marked bytes:
 *     a boundary-band ask denies gracefully (`via:'overcap'`) instead of
 *     composing a card the wire's own cap will refuse after the ratchet
 *     already advanced.
 */

const home = mkdtempSync(join(tmpdir(), 'tacendum-ai-origin-'));
process.env.TACENDUM_HOME = home;
process.env.TACENDUM_API = 'http://ai-origin.test';
process.env.TACENDUM_WS = 'ws://ai-origin.test';

const seams = vi.hoisted(() => ({
  driver: null as import('../src/attend-drivers.js').HostDriver | null,
  /** Legs captured at the REAL fan-out seam (send.js), for the one test that
   * drives `realSendRoomReply` end-to-end — every other room test passes an
   * explicit recording deliver and never reaches this. Null = not capturing
   * (and nothing in this suite may touch the real wire). */
  fanout: null as import('../src/send.js').FanoutLeg[][] | null,
}));

vi.mock('../src/attend-drivers.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/attend-drivers.js')>();
  return {
    ...real,
    driverFor: (host: Parameters<typeof real.driverFor>[0]) => seams.driver ?? real.driverFor(host),
  };
});
vi.mock('../src/send.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/send.js')>();
  return {
    ...real,
    sendEncryptedFanout: (async ({ legs }: { legs: import('../src/send.js').FanoutLeg[] }) => {
      if (seams.fanout === null) throw new Error('unexpected wire call (test)');
      seams.fanout.push(legs);
      return legs.map((l) => ({ to: l.to, msgId: l.msgId, state: 'delivered' as const }));
    }) as typeof real.sendEncryptedFanout,
  };
});

const { AI_DISCLOSURE_SENTENCE, markAgentBody, markerAttested } =
  await import('../src/ai-origin.js');
const attendMod = await import('../src/attend.js');
const { attendOnce, cmdAttendEnable, loadAttendConfig, realSendRoomReply, saveAttendConfig } =
  attendMod;
const { MAX_BODY_BYTES } = await import('../src/send.js');
type AttendConfig = import('../src/attend.js').AttendConfig;
type OutSess = import('../src/attend.js').OutSess;
type TypingChannel = import('../src/attend.js').TypingChannel;
type HostDriver = import('../src/attend-drivers.js').HostDriver;
type TurnRequest = import('../src/attend-drivers.js').TurnRequest;
const { MessageLog } = await import('../src/msglog.js');
const { saveProfile } = await import('../src/profile.js');
const { runNotify } = await import('../src/hooks.js');
type DeliverFn = import('../src/hooks.js').DeliverFn;
const { sendRoomMessage } = await import('../src/room-commands.js');
type RoomDelivery = import('../src/room-commands.js').RoomDelivery;
type FanoutLeg = import('../src/send.js').FanoutLeg;
const { FileGroupStore } = await import('../src/rooms.js');
const { applyGroupNew, ownerOnlyPolicy } = await import('@tacendum/shared/group-fold');
const { clientDir } = await import('../src/config.js');
const { Reporter } = await import('../src/output.js');
const { CliError, EXIT } = await import('../src/exit.js');
const { applyOwnerNotifyPreference } = await import('../src/ai-notify-preference.js');

const OWNER = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const SELF = '01HQXW0000000000000000TEST';
const OWN_SESSION = 'ffffffff-9999-4999-8999-999999999999';
const THREAD = 'f1f1f1f1-0000-4000-8000-000000000001';
const GID = '01GGGGGGGGGGGGGGGGGGGGGGGG';
const REPO_WORKDIR = join(home, 'context-fixture');

// Exercise real Git discovery without depending on the checkout's directory
// name, current branch, or even the presence of its .git metadata.
beforeAll(() => {
  mkdirSync(REPO_WORKDIR);
  const options = {
    cwd: REPO_WORKDIR,
    env: { HOME: home, PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1' },
    stdio: 'ignore' as const,
  };
  execFileSync('git', ['init', '--quiet', '--template='], options);
  execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/test/ai-origin'], options);
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

let seq = 0;
const mid = (): string => `01HQXS00000000000000${String(++seq).padStart(6, '0')}`.slice(0, 26);

const statePath = (f: string): string => join(home, 'state', 'bot', f);
const approvalRows = (): { msgId?: string; state: string }[] => {
  try {
    return (
      JSON.parse(readFileSync(statePath('attend-approvals.json'), 'utf8')) as {
        rows: { msgId?: string; state: string }[];
      }
    ).rows;
  } catch {
    return [];
  }
};

function inRow(text: string, opts: { tcm?: string; ref?: string; ts?: number } = {}) {
  return {
    id: mid(),
    dir: 'in' as const,
    peer: OWNER,
    ts: opts.ts ?? Date.now(),
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
    await new Promise((r) => setTimeout(r, 5));
  }
}

const clockIo = () => {
  let t = Date.now();
  return {
    now: () => t,
    sleep: async (ms: number): Promise<void> => {
      t += ms;
      await new Promise((r) => setTimeout(r, 2));
    },
  };
};

const fakeSend = () => {
  const sends: { body: string; id: string; notify?: false }[] = [];
  return {
    sends,
    bodies: () => sends.map((s) => s.body),
    sendReply: async (b: string, _sess?: OutSess, opts?: { notify?: boolean }): Promise<string> => {
      const id = mid();
      sends.push({ body: b, id, ...(opts?.notify === false ? { notify: false as const } : {}) });
      return id;
    },
  };
};

const typingFake = () => {
  const states: ('start' | 'stop')[] = [];
  const edits: string[] = [];
  return {
    states,
    edits,
    factory: (_to: string): TypingChannel => ({
      send: async (state: 'start' | 'stop'): Promise<void> => {
        states.push(state);
      },
      edit: async (body: string): Promise<void> => {
        edits.push(body);
      },
      close: (): void => {},
    }),
  };
};

const streamDriver = (
  opts: {
    reply?: string;
    code?: number;
    ask?: { payload: string; ttlMs: number; pushBeforeAsk?: string };
  } = {},
) => {
  let stream: ((s: string) => void) | undefined;
  let calls = 0;
  let release: (() => void) | undefined;
  const released = new Promise<void>((r) => {
    release = r;
  });
  const driver: HostDriver = {
    host: 'codex',
    async runTurn(req: TurnRequest) {
      calls += 1;
      stream = req.stream;
      req.steering?.({ sessionKey: THREAD, steer: async () => 'delivered' as const });
      if (opts.ask !== undefined && req.ask !== undefined) {
        if (opts.ask.pushBeforeAsk !== undefined) req.stream?.(opts.ask.pushBeforeAsk);
        await req.ask({ payload: opts.ask.payload, ttlMs: opts.ask.ttlMs });
      }
      await released;
      return {
        stdout: opts.reply ?? 'final answer',
        stderr: '',
        code: opts.code ?? 0,
        refusal: null,
      };
    },
  };
  return {
    driver,
    push: (s: string): void => stream?.(s),
    calls: () => calls,
    finish: () => release?.(),
  };
};

const cfg = (over: Partial<AttendConfig> = {}): void =>
  saveAttendConfig('bot', {
    host: 'codex',
    bin: '/opt/codex',
    workdir: '/w',
    caps: ['-s', 'read-only'],
    codexDriver: 'app-server',
    ownSession: OWN_SESSION,
    turnsPerHour: 10,
    ...over,
  });

/** Body → parsed envelope object, or null for bare text. */
const asEnvelope = (body: string): Record<string, unknown> | null => {
  if (!body.startsWith('{"tcm":')) return null;
  return JSON.parse(body) as Record<string, unknown>;
};

const report = () => new Reporter({ json: false, plain: true });

beforeEach(() => {
  rmSync(join(home, 'bot'), { recursive: true, force: true });
  rmSync(join(home, 'state'), { recursive: true, force: true });
  seq = 0;
  seams.driver = null;
  seams.fanout = null;
  saveProfile({
    name: 'bot',
    identityKey: 'AAAA',
    userId: SELF,
    deviceId: 1,
    authToken: 'tok',
    registrationId: 1,
    accountClass: 'integration',
    ownerUserId: OWNER,
  });
  cfg();
});

describe('markAgentBody — the one funnel', () => {
  it('wraps bare text into a marked msg envelope when attested, tcm first', () => {
    const out = markAgentBody('the tests are green', true);
    expect(out.startsWith('{"tcm":"msg"')).toBe(true);
    expect(JSON.parse(out)).toEqual({ tcm: 'msg', text: 'the tests are green', ai: true });
  });

  it('leaves bare text byte-identical when un-attested — the pre-marker phone path', () => {
    expect(markAgentBody('the tests are green', false)).toBe('the tests are green');
  });

  it('injects ai:true into an envelope body regardless of attestation, tcm still first', () => {
    const edit = JSON.stringify({ tcm: 'edit', ref: 'A'.repeat(26), text: 'done' });
    const out = markAgentBody(edit, false);
    expect(out.startsWith('{"tcm":"edit"')).toBe(true);
    expect(JSON.parse(out)).toEqual({ tcm: 'edit', ref: 'A'.repeat(26), text: 'done', ai: true });
  });

  it('is idempotent — one ai key, still true, on a body already marked', () => {
    const once = markAgentBody(JSON.stringify({ tcm: 'edit', ref: 'r', text: 't' }), false);
    const twice = markAgentBody(once, false);
    expect(twice.match(/"ai"/g)).toHaveLength(1);
    expect(JSON.parse(twice)).toEqual(JSON.parse(once));
  });

  it('never throws and never costs the message: sentinel-shaped non-JSON and oversized text pass through', () => {
    const broken = '{"tcm": not json at all';
    expect(markAgentBody(broken, true)).toBe(broken);
    const oversized = 'a'.repeat(30_000);
    expect(markAgentBody(oversized, true)).toBe(oversized);
  });
});

describe('markerAttested — one attestation file, every sender lane', () => {
  it('is false with no attend config, false on a malformed shape, true on a stated build', () => {
    expect(markerAttested('bot')).toBe(false); // config has no marker field
    cfg({ markerMinAppBuild: 4.5 });
    expect(markerAttested('bot')).toBe(false);
    cfg({ markerMinAppBuild: 11 });
    expect(markerAttested('bot')).toBe(true);
  });

  it('an unreadable or absent file reads as un-attested — fail closed', () => {
    rmSync(join(clientDir('bot'), 'attend.json'), { force: true });
    expect(markerAttested('bot')).toBe(false);
  });
});

describe('the one way out of attend is marked (the coverage pin)', () => {
  it('quiet mode suppresses only the successful 1:1 turn-complete push', async () => {
    cfg({ markerMinAppBuild: 11 });
    applyOwnerNotifyPreference(
      'bot',
      OWNER,
      OWNER,
      JSON.stringify({
        tcm: 'profile',
        n: '',
        a: '',
        v: 0,
        notifyPref: { q: '01HQXW0000000000000000PREF', routine: 'quiet' },
      }),
    );
    new MessageLog('bot').append(inRow('do the work'));
    seams.driver = {
      host: 'codex',
      async runTurn() {
        return { stdout: 'completed normally', stderr: '', code: 0, refusal: null };
      },
    };
    const h = fakeSend();

    expect(await attendOnce('bot', { ...clockIo(), sendReply: h.sendReply })).toBe('answered');
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]?.notify).toBe(false);
    expect(asEnvelope(h.sends[0]?.body as string)?.work).toMatchObject({
      event: 'turn-complete',
    });
  });

  it('quiet mode keeps a failed 1:1 turn push-enabled', async () => {
    cfg({ markerMinAppBuild: 11 });
    applyOwnerNotifyPreference(
      'bot',
      OWNER,
      OWNER,
      JSON.stringify({
        tcm: 'profile',
        n: '',
        a: '',
        v: 0,
        notifyPref: { q: '01HQXW0000000000000000PREF', routine: 'quiet' },
      }),
    );
    new MessageLog('bot').append(inRow('do the work'));
    seams.driver = {
      host: 'codex',
      async runTurn() {
        return { stdout: '', stderr: 'failed', code: 7, refusal: null };
      },
    };
    const h = fakeSend();

    expect(await attendOnce('bot', { ...clockIo(), sendReply: h.sendReply })).toBe('failed');
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]?.notify).toBeUndefined();
    expect(asEnvelope(h.sends[0]?.body as string)?.work).toMatchObject({ event: 'turn-failed' });
  });

  it('quiet mode suppresses the provisional stream and sends one quiet successful final', async () => {
    cfg({ markerMinAppBuild: 11, streamMinAppBuild: 11 });
    applyOwnerNotifyPreference(
      'bot',
      OWNER,
      OWNER,
      JSON.stringify({
        tcm: 'profile',
        n: '',
        a: '',
        v: 0,
        notifyPref: { q: '01HQXW0000000000000000PREF', routine: 'quiet' },
      }),
    );
    new MessageLog('bot').append(inRow('stream the work'));
    const fake = streamDriver({ reply: 'completed normally' });
    seams.driver = fake.driver;
    const h = fakeSend();
    const clock = clockIo();
    const typing = typingFake();
    const run = attendOnce('bot', {
      ...clock,
      sendReply: h.sendReply,
      typing: typing.factory,
    });

    await poll(() => fake.calls() === 1);
    fake.push('early routine progress');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(h.sends, 'Quiet must not mint a notifying provisional anchor').toHaveLength(0);
    expect(typing.edits).toHaveLength(0);

    // The stream made its one delivery choice when the first snapshot was
    // ready. A later preference applies to later turns; it cannot turn this
    // quiet turn's deferred final into a fresh interruption.
    applyOwnerNotifyPreference(
      'bot',
      OWNER,
      OWNER,
      JSON.stringify({
        tcm: 'profile',
        n: '',
        a: '',
        v: 0,
        notifyPref: { q: '01HQXZ0000000000000000PREF', routine: 'all' },
      }),
    );

    fake.finish();
    expect(await run).toBe('answered');
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]?.notify).toBe(false);
    const terminal = asEnvelope(h.sends[0]?.body as string)?.work as
      { event?: string; eventId?: string } | undefined;
    expect(terminal).toMatchObject({ event: 'turn-complete' });
    expect(terminal?.eventId).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  });

  it('quiet mode suppresses the provisional stream but keeps one failed final notifying', async () => {
    cfg({ markerMinAppBuild: 11, streamMinAppBuild: 11 });
    applyOwnerNotifyPreference(
      'bot',
      OWNER,
      OWNER,
      JSON.stringify({
        tcm: 'profile',
        n: '',
        a: '',
        v: 0,
        notifyPref: { q: '01HQXW0000000000000000PREF', routine: 'quiet' },
      }),
    );
    new MessageLog('bot').append(inRow('stream the risky work'));
    const fake = streamDriver({ reply: 'provider stopped', code: 7 });
    seams.driver = fake.driver;
    const h = fakeSend();
    const clock = clockIo();
    const typing = typingFake();
    const run = attendOnce('bot', {
      ...clock,
      sendReply: h.sendReply,
      typing: typing.factory,
    });

    await poll(() => fake.calls() === 1);
    fake.push('early routine progress');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(h.sends, 'Quiet must not mint a notifying provisional anchor').toHaveLength(0);
    expect(typing.edits).toHaveLength(0);

    fake.finish();
    expect(await run).toBe('failed');
    expect(h.sends).toHaveLength(1);
    expect(
      h.sends[0]?.notify,
      'failure keeps the transport default that wakes the owner',
    ).toBeUndefined();
    const terminal = asEnvelope(h.sends[0]?.body as string)?.work as
      { event?: string; eventId?: string } | undefined;
    expect(terminal).toMatchObject({ event: 'turn-failed' });
    expect(terminal?.eventId).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  });

  it('a terminal answer combines captured context, runnable tasks and exact native-hook support', async () => {
    cfg({
      host: 'claude',
      bin: process.execPath,
      workdir: REPO_WORKDIR,
      caps: ['--permission-mode', 'plan'],
      claudeDriver: 'subprocess',
      markerMinAppBuild: 11,
    });
    new MessageLog('bot').append(inRow('inspect this project'));
    seams.driver = {
      host: 'claude',
      async runTurn() {
        return { stdout: 'inspection complete', stderr: '', code: 0, refusal: null };
      },
    };
    const h = fakeSend();

    expect(
      await attendOnce('bot', {
        ...clockIo(),
        sendReply: h.sendReply,
        aiCapability: {
          inspectHost: () => ({ notificationConfigured: false, approvalsConfigured: true }),
          listenerStatus: () => ({ installed: true, running: true }),
        },
      }),
    ).toBe('answered');
    expect(h.sends).toHaveLength(1);
    const work = asEnvelope(h.sends[0]?.body as string)?.work as
      Record<string, unknown> | undefined;
    expect(work).toMatchObject({
      provider: 'claude',
      event: 'turn-complete',
      project: 'context-fixture',
      context: {
        availability: 'captured',
        repository: 'context-fixture',
        branch: 'test/ai-origin',
        capturedAt: expect.any(Number),
      },
      capabilities: { notifications: true, approvals: true, tasks: true },
    });
  });

  it('a terminal Claude SDK snapshot requires current package and API-key presence', async () => {
    cfg({
      host: 'claude',
      bin: process.execPath,
      workdir: REPO_WORKDIR,
      caps: ['--permission-mode', 'default'],
      claudeDriver: 'sdk',
      markerMinAppBuild: 11,
    });
    new MessageLog('bot').append(inRow('review this project'));
    seams.driver = {
      host: 'claude',
      async runTurn() {
        return { stdout: 'review complete', stderr: '', code: 0, refusal: null };
      },
    };
    const h = fakeSend();

    expect(
      await attendOnce('bot', {
        ...clockIo(),
        sendReply: h.sendReply,
        aiCapability: {
          inspectHost: () => ({ notificationConfigured: false, approvalsConfigured: false }),
          listenerStatus: () => ({ installed: true, running: true }),
          claudeSdkInstalled: () => true,
          claudeSdkApiKeyPresent: () => true,
        },
      }),
    ).toBe('answered');
    expect(asEnvelope(h.sends[0]?.body as string)?.work).toMatchObject({
      provider: 'claude',
      capabilities: { notifications: true, approvals: true, tasks: true },
    });
  });

  it('attested: card, anchor, intermediates and final ALL leave marked — no compose path escapes', async () => {
    cfg({
      markerMinAppBuild: 11,
      streamMinAppBuild: 11,
      approvalsMinAppBuild: 11,
      workdir: REPO_WORKDIR,
    });
    new MessageLog('bot').append(inRow('deploy it'));
    const fake = streamDriver({
      reply: 'done after approval',
      ask: { payload: 'make deploy', ttlMs: 3_600_000, pushBeforeAsk: 'early partial' },
    });
    seams.driver = fake.driver;
    const h = fakeSend();
    const clock = clockIo();
    const typing = typingFake();
    const io = { ...clock, sendReply: h.sendReply, typing: typing.factory };

    const run = attendOnce('bot', io);
    await poll(() => approvalRows()[0]?.state === 'pending');
    // The card left first; answer it so the stream resumes.
    const cardMsgId = approvalRows()[0]?.msgId as string;
    new MessageLog('bot').append(inRow('approve', { tcm: 'reply', ref: cardMsgId }));
    await poll(() => h.sends.length >= 2); // card + anchor
    fake.push('early partial, and more');
    await poll(() => typing.edits.length >= 1);
    fake.finish();
    expect(await run).toBe('answered');

    // EVERY durable body is an envelope carrying ai:true — the card
    // (x.approval), the anchor (msg wrapping the funneled snapshot), and
    // the durable final (edit). Nothing bare, nothing unmarked.
    expect(h.sends.length).toBeGreaterThanOrEqual(3);
    for (const s of h.sends) {
      const env = asEnvelope(s.body);
      expect(env, `unmarked bare body left the funnel: ${s.body}`).not.toBeNull();
      expect(env?.ai, `a body left unmarked: ${s.body}`).toBe(true);
    }
    const kinds = h.sends.map((s) => (asEnvelope(s.body) as { tcm: string }).tcm);
    expect(kinds).toContain('x.approval');
    expect(kinds).toContain('msg');
    expect(kinds).toContain('edit');
    const approval = h.sends
      .map((s) => asEnvelope(s.body))
      .find((e) => e?.tcm === 'x.approval') as {
      work?: { context?: Record<string, unknown> };
    };
    expect(approval.work?.context).toMatchObject({
      availability: 'captured',
      repository: 'context-fixture',
      branch: 'test/ai-origin',
      capturedAt: expect.any(Number),
    });
    const approvalRequestId = approval.work?.requestId as string;
    const observationSend = h.sends.find((s) => {
      const work = asEnvelope(s.body)?.work as { approvalObservation?: string } | undefined;
      return work?.approvalObservation === 'decision-returned';
    });
    expect(observationSend?.notify).toBe(false);
    const observation = asEnvelope(observationSend?.body as string) as {
      text?: string;
      work?: Record<string, unknown>;
    };
    expect(observation.text).toBe('Approval decision returned to codex.');
    expect(observation.work).toMatchObject({
      provider: 'codex',
      requestId: approvalRequestId,
      approvalObservation: 'decision-returned',
      updatedAt: expect.any(Number),
    });
    expect(observation.work?.event).toBeUndefined();
    expect(
      h.sends.some(
        (s) =>
          (asEnvelope(s.body)?.work as { approvalObservation?: string } | undefined)
            ?.approvalObservation === 'provider-received',
      ),
    ).toBe(false);
    // The anchor's words ride inside the msg wrapper, funneled and intact.
    const anchor = h.sends.map((s) => asEnvelope(s.body)).find((e) => e?.tcm === 'msg') as {
      text: string;
    };
    expect(anchor.text).toBe('early partial');
    const terminal = h.sends.map((s) => asEnvelope(s.body)).find((e) => e?.tcm === 'edit') as {
      work?: {
        provider?: string;
        event?: string;
        eventId?: string;
        updatedAt?: number;
        usage?: Array<Record<string, unknown>>;
      };
    };
    expect(terminal.work).toMatchObject({
      provider: 'codex',
      event: 'turn-complete',
      usage: [
        {
          source: 'local-budget',
          unit: 'turns',
          period: 'hour',
          used: 1,
          remaining: 9,
          limit: 10,
        },
      ],
    });
    expect(terminal.work?.eventId).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(terminal.work?.usage?.[0]?.observedAt).toBe(terminal.work?.updatedAt);
    // Every stream intermediate is marked too.
    expect(typing.edits.length).toBeGreaterThanOrEqual(1);
    for (const frame of typing.edits) {
      expect((JSON.parse(frame) as { ai?: boolean }).ai).toBe(true);
    }
  }, 30_000);

  it('a failed 1:1 turn emits one source-backed turn-failed event on its terminal reply', async () => {
    cfg({ markerMinAppBuild: 11 });
    new MessageLog('bot').append(inRow('do the work'));
    seams.driver = {
      host: 'codex',
      async runTurn() {
        return { stdout: '', stderr: '', code: 7, refusal: null, sessionKey: THREAD };
      },
    };
    const h = fakeSend();
    const clock = clockIo();
    expect(await attendOnce('bot', { ...clock, sendReply: h.sendReply })).toBe('failed');

    expect(h.sends).toHaveLength(1);
    const terminal = asEnvelope(h.sends[0]?.body as string) as {
      text?: string;
      work?: {
        provider?: string;
        event?: string;
        eventId?: string;
        runTag?: string;
        usage?: Array<Record<string, unknown>>;
      };
    };
    expect(terminal.text).toContain('The turn failed (exit 7)');
    expect(terminal.work).toMatchObject({
      provider: 'codex',
      event: 'turn-failed',
      runTag: expect.stringMatching(/^s-[0-9a-f]{4}$/),
      usage: [
        {
          source: 'local-budget',
          unit: 'turns',
          period: 'hour',
          used: 1,
          remaining: 9,
          limit: 10,
        },
      ],
    });
    expect(terminal.work?.eventId).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  });

  it('an error returned immediately after an approval callback claims only decision-returned', async () => {
    cfg({ markerMinAppBuild: 11, approvalsMinAppBuild: 11 });
    new MessageLog('bot').append(inRow('try the work'));
    seams.driver = {
      host: 'codex',
      async runTurn(req) {
        await req.ask?.({ payload: 'touch result.txt', kind: 'commandExecution' });
        return { stdout: '', stderr: 'host stopped', code: 7, refusal: null };
      },
    };
    const h = fakeSend();
    const run = attendOnce('bot', { ...clockIo(), sendReply: h.sendReply });
    await poll(() => approvalRows()[0]?.state === 'pending');
    const approval = approvalRows()[0] as { msgId?: string };
    new MessageLog('bot').append(inRow('approve', { tcm: 'reply', ref: approval.msgId }));

    expect(await run).toBe('failed');
    const observations = h.sends
      .map((s) => ({ send: s, envelope: asEnvelope(s.body) }))
      .filter(
        (item) =>
          (item.envelope?.work as { approvalObservation?: string } | undefined)
            ?.approvalObservation !== undefined,
      );
    expect(observations).toHaveLength(1);
    expect(observations[0]?.send.notify).toBe(false);
    expect(observations[0]?.envelope?.work).toMatchObject({
      approvalObservation: 'decision-returned',
    });
    expect(JSON.stringify(h.sends)).not.toContain('provider-received');
  }, 30_000);

  it('un-attested marker: bare text is byte-identical to today, while envelope bodies still carry ai', async () => {
    cfg({ streamMinAppBuild: 11 }); // stream attested; marker NOT
    new MessageLog('bot').append(inRow('do the work'));
    const fake = streamDriver({ reply: 'the answer' });
    seams.driver = fake.driver;
    const h = fakeSend();
    const clock = clockIo();
    const typing = typingFake();
    const io = { ...clock, sendReply: h.sendReply, typing: typing.factory };

    const run = attendOnce('bot', io);
    await poll(() => fake.calls() === 1);
    fake.push('half a thought');
    await poll(() => h.sends.length >= 1); // the anchor
    fake.finish();
    expect(await run).toBe('answered');

    // The anchor is bare text, byte-identical to the funneled snapshot —
    // wrapping it would freeze "Unsupported message" onto a pre-marker
    // phone the operator never attested past.
    expect(h.sends[0]?.body).toBe('half a thought');
    // The durable final is an envelope on a KNOWN kind: marked regardless,
    // because deployed parsers strip unknown fields (the compatibility
    // finding this split stands on).
    const final = asEnvelope((h.sends.at(-1) as { body: string }).body) as {
      tcm: string;
      ai?: boolean;
    };
    expect(final.tcm).toBe('edit');
    expect(final.ai).toBe(true);
  }, 30_000);
});

describe('the room wrapper (the marker rides grp.msg, and inside b iff b is an envelope)', () => {
  function seedRoom(): void {
    const store = FileGroupStore.load('bot', GID);
    applyGroupNew(
      store,
      SELF,
      { writerId: OWNER, members: [OWNER, SELF], seq: 1 },
      ownerOnlyPolicy,
    );
    store.persist();
  }

  function recordingDeliver(captured: FanoutLeg[][]): RoomDelivery {
    return (async ({ legs }: { legs: FanoutLeg[] }) => {
      captured.push(legs);
      return legs.map((l) => ({ to: l.to, msgId: l.msgId, state: 'delivered' as const }));
    }) as RoomDelivery;
  }

  it('an agent room reply marks the wrapper and leaves BARE-TEXT b bare — a pre-marker stranger still reads the words', async () => {
    seedRoom();
    const captured: FanoutLeg[][] = [];
    await sendRoomMessage('bot', GID, 'the room answer', recordingDeliver(captured), () => {}, {
      ai: true,
    });
    expect(captured).toHaveLength(1);
    const body = JSON.parse((captured[0]?.[0] as FanoutLeg).body) as {
      tcm: string;
      b: string;
      ai?: boolean;
    };
    expect(body.tcm).toBe('grp.msg');
    expect(body.ai).toBe(true);
    // Bare text has no field to carry the claim (the amendment's
    // own words) — wrapping it into `msg` would freeze "Unsupported message"
    // onto every stranger's pre-marker phone, the exact population the
    // wrapper exists for.
    expect(body.b).toBe('the room answer');
  });

  it('an ENVELOPE b carries ai INSIDE as well as on the wrapper — the claim survives a grp.hist relay of the b bytes', async () => {
    seedRoom();
    const inner = JSON.stringify({
      tcm: 'mention',
      text: '￼ the tests are green',
      who: [OWNER],
    });
    const captured: FanoutLeg[][] = [];
    await sendRoomMessage('bot', GID, inner, recordingDeliver(captured), () => {}, { ai: true });
    const body = JSON.parse((captured[0]?.[0] as FanoutLeg).body) as {
      tcm: string;
      b: string;
      ai?: boolean;
    };
    // Direction 1 (mutation: drop the wrapper ai → red).
    expect(body.ai).toBe(true);
    // Direction 2 (mutation: drop the inner marking → red). `tcm` still
    // serialized first — parseEnvelope routes on the literal prefix.
    expect(body.b.startsWith('{"tcm":"mention"')).toBe(true);
    expect(JSON.parse(body.b)).toEqual({
      tcm: 'mention',
      text: '￼ the tests are green',
      who: [OWNER],
      ai: true,
    });
  });

  it('an operator room send stays unmarked — wrapper AND inner — agent-authored means through the agent lane, not by account class', async () => {
    seedRoom();
    const inner = JSON.stringify({ tcm: 'mention', text: '￼ typed by a person', who: [OWNER] });
    for (const text of ['typed by a person', inner]) {
      const captured: FanoutLeg[][] = [];
      await sendRoomMessage('bot', GID, text, recordingDeliver(captured));
      const body = JSON.parse((captured[0]?.[0] as FanoutLeg).body) as Record<string, unknown>;
      expect(body).not.toHaveProperty('ai');
      expect(body.b).toBe(text); // byte-identical: no marking without the agent lane
    }
  });

  it('END TO END: realSendRoomReply marks the wrapper (and an envelope b inside) all the way to the fan-out legs', async () => {
    // The real room reply transport, the real sendRoomMessage, the real
    // mintLegs — only send.js's wire call is the capture seam. This is the
    // lane gate.room-trigger.test.ts's passthrough once dropped: a mutation
    // deleting `{ ai: true }` at attend's one marking site goes red HERE.
    seedRoom();
    seams.fanout = [];
    const bare = await realSendRoomReply('bot', GID, 'the room answer');
    expect(bare).not.toHaveProperty('refused');
    const inner = JSON.stringify({ tcm: 'mention', text: '￼ done', who: [OWNER] });
    await realSendRoomReply('bot', GID, inner);
    expect(seams.fanout).toHaveLength(2);
    const bodies = seams.fanout.map(
      (legs) => JSON.parse((legs[0] as FanoutLeg).body) as { b: string; ai?: boolean },
    );
    expect(bodies[0]?.ai).toBe(true);
    expect(bodies[0]?.b).toBe('the room answer'); // bare text stays bare
    expect(bodies[1]?.ai).toBe(true);
    expect((JSON.parse(bodies[1]?.b ?? '{}') as { ai?: boolean }).ai).toBe(true);
  });
});

describe('the notify lane marks through the same funnel', () => {
  const stdinOf = (payload: unknown) => () => JSON.stringify(payload);

  function recordingDeliver(): { calls: { body: string }[]; fn: DeliverFn } {
    const calls: { body: string }[] = [];
    const fn: DeliverFn = async ({ body, msgId }) => {
      calls.push({ body });
      return { msgId, state: 'sent' };
    };
    return { calls, fn };
  }

  it('attested: a hook notification leaves as a marked msg envelope with the words inside', async () => {
    cfg({ markerMinAppBuild: 11 });
    const { calls, fn } = recordingDeliver();
    const code = await runNotify(['--hook', 'claude', '--account', 'bot'], report(), {
      deliver: fn,
      readStdin: stdinOf({
        hook_event_name: 'Stop',
        cwd: '/w/proj',
        last_assistant_message: 'the build is green',
      }),
    });
    expect(code).toBe(EXIT.OK);
    expect(calls).toHaveLength(1);
    const env = asEnvelope(calls[0]?.body ?? '') as { tcm: string; text: string; ai?: boolean };
    expect(env.tcm).toBe('msg');
    expect(env.ai).toBe(true);
    expect(env.text).toBe('proj: agent finished\nthe build is green');
  });

  it('un-attested: the hook body is byte-identical to today', async () => {
    const { calls, fn } = recordingDeliver();
    const code = await runNotify(['--hook', 'claude', '--account', 'bot'], report(), {
      deliver: fn,
      readStdin: stdinOf({
        hook_event_name: 'Stop',
        cwd: '/w/proj',
        last_assistant_message: 'the build is green',
      }),
    });
    expect(code).toBe(EXIT.OK);
    expect(calls[0]?.body).toBe('proj: agent finished\nthe build is green');
  });

  it('attested but --to a NON-OWNER: byte-bare — the attestation speaks only for the owner’s phone', async () => {
    // A same-crew integration on a pre-msg CLI has no `case 'msg'` in its
    // renderBody: `maySpool` refuses the row and the message is DROPPED
    // whole, not degraded. The owner attested THEIR phone, nobody else's
    // device, so a `--to` send must leave exactly as it left yesterday.
    cfg({ markerMinAppBuild: 11 });
    const crewmate = '01BX5ZZKBKACTAV9WEVGEMMVRY';
    const { calls, fn } = recordingDeliver();
    const code = await runNotify(
      ['--hook', 'claude', '--account', 'bot', '--to', crewmate],
      report(),
      {
        deliver: fn,
        readStdin: stdinOf({
          hook_event_name: 'Stop',
          cwd: '/w/proj',
          last_assistant_message: 'the build is green',
        }),
      },
    );
    expect(code).toBe(EXIT.OK);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toBe('proj: agent finished\nthe build is green');
  });

  it('attested and addressed to the owner EXPLICITLY (--to <owner>): still marked — the gate is the recipient, not the flag', async () => {
    cfg({ markerMinAppBuild: 11 });
    const { calls, fn } = recordingDeliver();
    const code = await runNotify(
      ['--hook', 'claude', '--account', 'bot', '--to', OWNER],
      report(),
      {
        deliver: fn,
        readStdin: stdinOf({
          hook_event_name: 'Stop',
          cwd: '/w/proj',
          last_assistant_message: 'the build is green',
        }),
      },
    );
    expect(code).toBe(EXIT.OK);
    const env = asEnvelope(calls[0]?.body ?? '') as { tcm: string; ai?: boolean };
    expect(env?.tcm).toBe('msg');
    expect(env?.ai).toBe(true);
  });
});

describe('attend enable --marker (the attestation surface)', () => {
  const enable = (extra: Record<string, unknown>): void =>
    cmdAttendEnable('bot', { host: 'codex', bin: process.execPath, ...extra }, report());

  it('writes the attestation and arms the funnel', () => {
    enable({ markerMinAppBuild: 11 });
    expect(loadAttendConfig('bot')?.markerMinAppBuild).toBe(11);
    expect(markerAttested('bot')).toBe(true);
  });

  it('refuses a malformed shape — a floor of zero gates nothing', () => {
    for (const bad of [0, -1, 4.5]) {
      try {
        enable({ markerMinAppBuild: bad });
        expect.unreachable('a malformed --marker must refuse');
      } catch (err) {
        expect(err).toBeInstanceOf(CliError);
        expect((err as InstanceType<typeof CliError>).exitCode).toBe(EXIT.USAGE);
      }
    }
  });

  it('absent stays absent: enabling without the flag writes no field and arms nothing', () => {
    enable({});
    expect(loadAttendConfig('bot')?.markerMinAppBuild).toBeUndefined();
    expect(markerAttested('bot')).toBe(false);
  });
});

describe('the --marker read-back copy (one paragraph, both hosts, and the ungated arm disclosed)', () => {
  const humanOf = (opts: Record<string, unknown>): string => {
    const human: string[] = [];
    const rep = report();
    rep.emit = (_r: Record<string, unknown>, h: string) => void human.push(h);
    cmdAttendEnable('bot', { bin: process.execPath, ...opts }, rep);
    return human.join('\n');
  };
  const PARAGRAPH = /Replies will carry the AI-origin marker[\s\S]*?--marker\./;

  it('--marker: the attestation paragraph is ONE constant, verbatim on both host branches', () => {
    const codex = humanOf({ host: 'codex', markerMinAppBuild: 11 });
    const claude = humanOf({ host: 'claude', markerMinAppBuild: 11 });
    const said = codex.match(PARAGRAPH)?.[0];
    expect(said).toBeDefined();
    expect(claude.match(PARAGRAPH)?.[0]).toBe(said);
    expect(said).toContain('ATTESTATION');
    expect(said).toContain('app build 11');
    expect(said).toContain('cannot check');
    expect(said).toContain('re-run enable without --marker');
  });

  it('WITHOUT --marker the read-back still discloses the ungated envelope-arm marking, on both hosts', () => {
    // The envelope arm marks regardless of the flag (ai-origin.ts holds the
    // compatibility argument), and a read-back that only spoke when the flag
    // was passed would leave the operator believing nothing is marked.
    for (const host of ['codex', 'claude']) {
      const said = humanOf({ host });
      expect(said, host).toContain('AI-origin marker');
      expect(said, host).toContain('regardless');
      expect(said, host).toContain('--marker');
      // No attestation was made, so the copy must not claim one.
      expect(said, host).not.toContain('ATTESTATION');
    }
  });
});

/**
 * THE 5.1.2(i) DISCLOSURE (docs/AI-DISCLOSURE.md §1 and §4's onboarding row).
 * `attend enable` is the operator-side half of "before the first reply can
 * reach an agent": it is the deliberate act that arms the answerer, so it is
 * the last moment the data-flow sentence can be said in time.
 *
 * Two things are pinned, and the second is the one that matters: the read-back
 * carries the sentence on BOTH hosts with and without every attestation flag,
 * and the constant equals §1 of the doc byte for byte. The doc is the
 * sentence's single home; a constant that has quietly drifted from it is
 * exactly the failure the doc names ("page copy has gone live false twice").
 */
describe('the AI-disclosure sentence (Apple 5.1.2(i) / EU AI Act Art. 50)', () => {
  const DOC = fileURLToPath(new URL('../../../docs/AI-DISCLOSURE.md', import.meta.url));

  /** §1's blockquote, unwrapped from the doc's hard wrap, bold and quotes.
   * Narrow on purpose: it reads §1 or it throws — never another quotation. */
  const canonicalFromDoc = (): string => {
    const section = readFileSync(DOC, 'utf8')
      .split(/^## /m)
      .find((s) => s.startsWith('1. The canonical sentence'));
    if (section === undefined) throw new Error('docs/AI-DISCLOSURE.md has no §1');
    const quoted = section
      .split('\n')
      .filter((l) => l.startsWith('> '))
      .map((l) => l.slice(2).trim());
    if (quoted.length === 0) throw new Error('§1 carries no blockquote');
    return quoted
      .join(' ')
      .replace(/^\*\*"/, '')
      .replace(/"\*\*$/, '');
  };

  const humanOf = (opts: Record<string, unknown>): string => {
    const human: string[] = [];
    const rep = report();
    rep.emit = (_r: Record<string, unknown>, h: string) => void human.push(h);
    cmdAttendEnable('bot', { bin: process.execPath, ...opts }, rep);
    return human.join('\n');
  };

  it('is EXACTLY these bytes', () => {
    expect(AI_DISCLOSURE_SENTENCE).toBe(
      'Replies you send are delivered to the AI provider through a client running on your machine; ' +
        "Tacendum's servers relay message ciphertext, not plaintext.",
    );
  });

  it('equals docs/AI-DISCLOSURE.md §1, byte for byte', () => {
    expect(AI_DISCLOSURE_SENTENCE).toBe(canonicalFromDoc());
  });

  it('the comparison can actually fail — a paraphrase of the doc text is not equal', () => {
    expect(
      canonicalFromDoc().replace(
        'through a client running on your machine',
        'through a local client',
      ),
    ).not.toBe(AI_DISCLOSURE_SENTENCE);
  });

  it('attend enable prints it, VERBATIM, on both hosts and with or without --marker', () => {
    for (const host of ['codex', 'claude']) {
      for (const extra of [{}, { markerMinAppBuild: 11 }]) {
        const said = humanOf({ host, ...extra });
        expect(said, `${host} ${JSON.stringify(extra)}`).toContain(AI_DISCLOSURE_SENTENCE);
        // §4 also asks for the plain statement of what this account is.
        expect(said, `${host} ${JSON.stringify(extra)}`).toContain('AI agent');
      }
    }
  });

  it('the disclosure is ONE string, not a per-branch copy that can drift', () => {
    // The two host branches emit different prose around it; the sentence
    // itself must be the same object's bytes in both, which is what
    // `toContain(AI_DISCLOSURE_SENTENCE)` above already forces — this pins
    // the count so a future edit cannot say it twice in one read-back and
    // call that "both branches carry it".
    const occurrences = (s: string): number => s.split(AI_DISCLOSURE_SENTENCE).length - 1;
    expect(occurrences(humanOf({ host: 'codex' }))).toBe(1);
    expect(occurrences(humanOf({ host: 'claude' }))).toBe(1);
  });
});

describe('the approval-card cap guard sees the FINAL marked bytes (boundary band)', () => {
  /** One attested account per pass — a second pass on the same account would
   * re-read the first pass's answered reply row and route it as `ended`
   * instead of spawning the turn under test. */
  const seed = (name: string): void => {
    saveProfile({
      name,
      identityKey: 'AAAA',
      userId: SELF,
      deviceId: 1,
      authToken: 'tok',
      registrationId: 1,
      accountClass: 'integration',
      ownerUserId: OWNER,
    });
    saveAttendConfig(name, {
      host: 'codex',
      bin: '/opt/codex',
      workdir: '/w',
      caps: ['-s', 'read-only'],
      codexDriver: 'app-server',
      ownSession: OWN_SESSION,
      turnsPerHour: 10,
      markerMinAppBuild: 11,
      approvalsMinAppBuild: 11,
    });
  };
  const approvalsFile = (
    name: string,
  ): {
    rows: { msgId?: string; state: string; decision?: string; via?: string }[];
    overCapRefusals: number;
  } =>
    JSON.parse(readFileSync(join(home, 'state', name, 'attend-approvals.json'), 'utf8')) as {
      rows: { msgId?: string; state: string; decision?: string; via?: string }[];
      overCapRefusals: number;
    };

  /** Drive one attested attend turn whose driver asks ONCE with `payload`,
   * answering the card (if one lands) so the pass completes. Returns every
   * body the pass sent. */
  async function turnWithAsk(account: string, payload: string): Promise<{ body: string }[]> {
    seed(account);
    new MessageLog(account).append(inRow('do the thing'));
    const fake = streamDriver({ reply: 'done', ask: { payload, ttlMs: 3_600_000 } });
    seams.driver = fake.driver;
    const h = fakeSend();
    const clock = clockIo();
    const typing = typingFake();
    const io = { ...clock, sendReply: h.sendReply, typing: typing.factory };
    const run = attendOnce(account, io);
    await poll(() =>
      (() => {
        try {
          return approvalsFile(account).rows.some(
            (r) => r.state === 'pending' || r.state === 'answering',
          );
        } catch {
          return false;
        }
      })(),
    );
    const row = approvalsFile(account).rows[0] as { msgId?: string; state: string };
    if (row.state === 'pending') {
      new MessageLog(account).append(inRow('approve', { tcm: 'reply', ref: row.msgId as string }));
    }
    fake.finish();
    await run;
    return h.sends;
  }

  it('supplementary work yields at the frame boundary before an exact approval payload is refused', async () => {
    // MEASURE: a small ask lands a real card. q/eventId are fixed-width and
    // the fixture clock keeps every timestamp at the same digit width, so
    // removing `work` from these parsed bytes gives the legacy card overhead
    // for a second account without guessing at JSON escaping.
    const probe = 'measure me';
    const sends1 = await turnWithAsk('band-measure', probe);
    const card = sends1.map((s) => asEnvelope(s.body)).find((e) => e?.tcm === 'x.approval');
    expect(card, 'the measuring ask must land a card').toBeDefined();
    expect(card?.ai, 'the measured card carries the marker inside the cap').toBe(true);
    expect(card?.work, 'small cards carry the supplementary work fact').toBeDefined();
    const legacy = { ...card };
    delete legacy.work;
    const legacyOverhead = Buffer.byteLength(JSON.stringify(legacy), 'utf8') - probe.length;

    // THE BAND: the legacy, marked card fits exactly; adding optional work
    // does not. The immutable approval payload outranks its supplementary
    // activity decoration, so the card must still leave with p byte-exact.
    const payload = 'p'.repeat(MAX_BODY_BYTES - legacyOverhead);
    const sends2 = await turnWithAsk('band-over', payload);
    const after = approvalsFile('band-over');
    expect(after.overCapRefusals).toBe(0);
    const boundaryBody = sends2.find((s) => asEnvelope(s.body)?.tcm === 'x.approval')?.body;
    expect(boundaryBody, 'the approval card still leaves').toBeDefined();
    const boundary = JSON.parse(boundaryBody as string) as Record<string, unknown>;
    expect(boundary.p).toBe(payload);
    expect(boundary.work, 'supplementary work is the field that yields').toBeUndefined();
    expect(Buffer.byteLength(boundaryBody as string, 'utf8')).toBe(MAX_BODY_BYTES);
    for (const s of sends2) {
      expect(Buffer.byteLength(s.body, 'utf8')).toBeLessThanOrEqual(MAX_BODY_BYTES);
    }
  }, 30_000);
});
