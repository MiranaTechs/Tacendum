import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monotonicFactory } from 'ulid';
import type { ClientFrame, PrekeyBundle, ServerFrame } from '@tacendum/shared';

const home = mkdtempSync(join(tmpdir(), 'tacendum-inbox-rounds-'));
process.env.TACENDUM_HOME = home;

const { saveProfile } = await import('../src/profile.js');
const { MessageLog } = await import('../src/msglog.js');
const { FileStores } = await import('../src/stores.js');
const { generateAndStoreKeys, establishSession, encryptText } = await import(
  '../src/messaging.js'
);
const { attachInbound } = await import('../src/inbound.js');
type WsClient = import('../src/wsclient.js').WsClient;
type Reporter = import('../src/output.js').Reporter;

const CLI = join(process.cwd(), 'packages/cli/src/main.ts');
const DEAD_API = 'http://127.0.0.1:9';
const DEAD_WS = 'ws://127.0.0.1:9/ws';

const ALICE = '01ALICEALICEALICEALICEALIC';
const BOB = '01BOBBOBBOBBOBBOBBOBBOBBOB';
const REF = `${ALICE}.01MMMMMMMMMMMMMMMMMMMMMMMM`;
const ulid = monotonicFactory();

const BRIEF = 'the retry storm is ours';
const DETAIL = 'Full finding:\nthe backoff resets on every 429.';

/**
 * task 5 (§3.7) — brief-first everywhere, the rest on
 * request.
 *
 * The default is the decision under test as much as the flag is: `inbox` and
 * `listen` are surfaces people grep, and a 3 000-character finding wrapping
 * between two `[peer] …` lines would end that. So without `--detail` the two
 * surfaces are byte-identical to what they were, and with it the detail is
 * printed under its own brief through the same `prefixLines` the brief uses —
 * every line of it, because those newlines are the peer's and a line of peer
 * plaintext starting at column zero is the forgery this program is careful
 * about elsewhere.
 */

function run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI, ...args], {
      env: {
        ...process.env,
        TACENDUM_HOME: home,
        TACENDUM_API: DEAD_API,
        TACENDUM_WS: DEAD_WS,
        NODE_USE_SYSTEM_CA: '0',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.end();
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

function seed(name: string): InstanceType<typeof MessageLog> {
  saveProfile({
    name,
    identityKey: 'IDKEYMARKER==',
    userId: BOB,
    authToken: 'tok-SECRET-DO-NOT-EMIT',
    registrationId: 7,
    deviceId: 1,
  });
  const log = new MessageLog(name);
  log.append({
    id: ulid(),
    dir: 'in',
    peer: ALICE,
    ts: Date.now(),
    tcm: 'reply',
    text: BRIEF,
    read: false,
    ref: REF,
    detail: DETAIL,
  });
  return log;
}

describe('tacendum inbox --detail', () => {
  it('shows the brief alone by default and the detail under it on request', async () => {
    seed('inbox-detail');

    // `--peek`, so the two runs see the same row: reading marks read, and a
    // marked row is on its way to redaction.
    const plain = await run(['inbox', 'inbox-detail', '--peek', '--plain']);
    expect(plain.code).toBe(0);
    expect(plain.stdout).toContain(BRIEF);
    // The default listing is the width it has always been.
    expect(plain.stdout).not.toContain('Full finding');
    expect(plain.stdout).not.toContain('the backoff resets');

    const detailed = await run(['inbox', 'inbox-detail', '--peek', '--plain', '--detail']);
    expect(detailed.code).toBe(0);
    expect(detailed.stdout).toContain(BRIEF);
    expect(detailed.stdout).toContain('Full finding:');
    expect(detailed.stdout).toContain('the backoff resets on every 429.');
    // EVERY line of the detail is prefixed — the second line of it must not
    // arrive at column zero exactly as the peer composed it.
    for (const line of detailed.stdout.split('\n')) {
      if (line.includes('the backoff resets')) expect(line).toContain(`[${ALICE}]`);
    }
    // The brief's line still comes first.
    expect(detailed.stdout.indexOf(BRIEF)).toBeLessThan(detailed.stdout.indexOf('Full finding:'));
  }, 30_000);

  it('carries the detail in --json only under the flag', async () => {
    seed('inbox-json');

    const bare = await run(['inbox', 'inbox-json', '--peek', '--json']);
    const bareRow = JSON.parse(bare.stdout.split('\n').filter(Boolean)[0] as string) as Record<
      string,
      unknown
    >;
    expect(bareRow.text).toBe(BRIEF);
    expect('detail' in bareRow).toBe(false);

    const asked = await run(['inbox', 'inbox-json', '--peek', '--json', '--detail']);
    const askedRow = JSON.parse(asked.stdout.split('\n').filter(Boolean)[0] as string) as Record<
      string,
      unknown
    >;
    // `text` is STILL the brief: the flag adds a field, it does not rewrite
    // the one every existing reader parses.
    expect(askedRow.text).toBe(BRIEF);
    expect(askedRow.detail).toBe(DETAIL);
  }, 30_000);
});

/** The two WsClient methods the inbound policy uses, capturable. */
class FakeWs {
  handlers: ((f: ServerFrame) => void)[] = [];
  sent: ClientFrame[] = [];
  onFrame(h: (f: ServerFrame) => void): void {
    this.handlers.push(h);
  }
  send(f: ClientFrame): void {
    this.sent.push(f);
  }
  deliver(f: ServerFrame): void {
    for (const h of this.handlers) h(f);
  }
}

/** A human-mode Reporter double: the printed LINE is what is under test. */
function fakeReporter(): { r: Reporter; lines: string[]; records: Record<string, unknown>[] } {
  const lines: string[] = [];
  const records: Record<string, unknown>[] = [];
  const r = {
    json: false,
    plain: true,
    line: (record: Record<string, unknown>, human: string) => {
      records.push(record);
      lines.push(human);
    },
    emit: () => {},
    note: () => {},
    status: () => {},
    done: () => {},
  } as unknown as Reporter;
  return { r, lines, records };
}

describe('tacendum listen --detail', () => {
  const senderStores = new FileStores('lst-alice');
  const selfStores = new FileStores('lst-bob');
  const log = new MessageLog('lst-bob');

  async function deliver(detail: boolean, spool: typeof log = log) {
    const body = JSON.stringify({ tcm: 'reply', ref: REF, ofs: false, text: BRIEF, d: DETAIL });
    const { msgType, payload } = await encryptText(senderStores, ALICE, BOB, body);
    const ws = new FakeWs();
    const { r, lines, records } = fakeReporter();
    const inbound = attachInbound({
      name: 'lst-bob',
      userId: BOB,
      stores: selfStores,
      ws: ws as unknown as WsClient,
      report: r,
      log: spool,
      consume: true,
      detail,
    });
    ws.deliver({ type: 'msg', from: ALICE, msgId: ulid(), msgType, payload, ts: Date.now() });
    await inbound.settled();
    return { lines, records };
  }

  it('prints the brief alone by default and both on request — from real ciphertext', async () => {
    const keys = await generateAndStoreKeys(selfStores);
    await generateAndStoreKeys(senderStores);
    const bundle: PrekeyBundle = {
      userId: BOB,
      registrationId: keys.registrationId,
      identityKey: keys.identityKey,
      signedPrekey: keys.signedPrekey,
      kyberPrekey: keys.kyberPrekey,
      oneTimePrekey: keys.oneTimePrekeys[0],
    };
    await establishSession(senderStores, ALICE, bundle);

    const off = await deliver(false);
    expect(off.lines.join('\n')).toContain(BRIEF);
    expect(off.lines.join('\n')).not.toContain('Full finding');
    // …and the `--json` record is the shape it has always been.
    expect('detail' in (off.records[0] ?? {})).toBe(false);

    const on = await deliver(true);
    const printed = on.lines.join('\n');
    expect(printed).toContain(BRIEF);
    expect(printed).toContain('Full finding:');
    expect(printed).toContain('the backoff resets on every 429.');
    for (const line of printed.split('\n')) {
      if (line.includes('the backoff resets')) expect(line.startsWith(`[${ALICE}]`)).toBe(true);
    }
    // The machine record carries it too, under the same one flag — the two
    // modes agree about what `--detail` means.
    expect(on.records[0]?.detail).toBe(DETAIL);
    // The spool kept both halves, whatever the terminal was asked to show.
    const [row] = log.read({ limit: 1 });
    expect(row?.text).toBe(BRIEF);
    expect(row?.detail).toBe(DETAIL);
  }, 30_000);

  it('prints BOTH halves when the spool write fails, whatever --detail said', async () => {
    // The spool write failing is the one place `--detail` has no business:
    // this print is then the last copy of the plaintext (inbound.ts says so
    // at the site), and a flag nobody passed would erase the half the
    // quarantine literal argues hardest to keep. So: flag OFF, both halves.
    const failing = new MessageLog('lst-bob');
    failing.append = () => {
      // No path, no body, no errno detail — the code reads only `localErrno`.
      throw Object.assign(new Error('append refused'), { code: 'EDQUOT' });
    };

    const { lines, records } = await deliver(false, failing);
    const printed = lines.join('\n');
    expect(printed).toContain(BRIEF);
    expect(printed).toContain('Full finding:');
    expect(printed).toContain('the backoff resets on every 429.');
    // Still prefixed on every line: the custody print is peer plaintext too.
    for (const line of printed.split('\n')) {
      if (line.includes('the backoff resets')) expect(line.startsWith(`[${ALICE}]`)).toBe(true);
    }
    // And the machine record carries the whole message, flagged unlogged.
    expect(records[0]?.unlogged).toBe(true);
    expect(records[0]?.text).toBe(BRIEF);
    expect(records[0]?.detail).toBe(DETAIL);
  }, 30_000);
});

describe('tacendum listen --calls --detail', () => {
  it('is refused rather than silently ignored', async () => {
    seed('listen-calls-detail');
    // args.ts refuses an unknown flag rather than dropping it, so `--detail`
    // must be declared for the whole subcommand — but accepting it on the
    // calls arm and doing nothing is that same lie one level in. The
    // operator would have no way to tell a no-op from a message that simply
    // carried no detail, so the combination exits USAGE before anything dials.
    const r = await run(['listen', 'listen-calls-detail', '--calls', '--detail', '--plain']);
    expect(r.code).toBe(9);
    expect(`${r.stdout}${r.stderr}`).toContain('does not take --detail');
  }, 30_000);
});
