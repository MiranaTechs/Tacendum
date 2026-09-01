import { describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monotonicFactory } from 'ulid';
import type { ClientFrame, PrekeyBundle, ServerFrame } from '@tacendum/shared';

const home = mkdtempSync(join(tmpdir(), 'tacendum-inbound-'));
process.env.TACENDUM_HOME = home;

const { FileStores } = await import('../src/stores.js');
const { generateAndStoreKeys, establishSession, encryptText } = await import(
  '../src/messaging.js'
);
const { attachInbound, watchQuiet } = await import('../src/inbound.js');
const { MessageLog } = await import('../src/msglog.js');
type WsClient = import('../src/wsclient.js').WsClient;
type Reporter = import('../src/output.js').Reporter;

const ALICE = '01ALICEALICEALICEALICEALIC';
const BOB = '01BOBBOBBOBBOBBOBBOBBOBBOB';
const ulid = monotonicFactory();

function bundleFrom(
  userId: string,
  upload: Awaited<ReturnType<typeof generateAndStoreKeys>>,
): PrekeyBundle {
  return {
    userId,
    registrationId: upload.registrationId,
    identityKey: upload.identityKey,
    signedPrekey: upload.signedPrekey,
    kyberPrekey: upload.kyberPrekey,
    oneTimePrekey: upload.oneTimePrekeys[0],
  };
}

/** The two WsClient methods the inbound policy uses, capturable. */
class FakeWs {
  handlers: ((f: ServerFrame) => void)[] = [];
  sent: ClientFrame[] = [];
  onAck: ((msgId: string) => void) | null = null;
  onFrame(h: (f: ServerFrame) => void): void {
    this.handlers.push(h);
  }
  send(f: ClientFrame): void {
    this.sent.push(f);
    if (f.type === 'ack' && this.onAck) this.onAck(f.msgId);
  }
  deliver(f: ServerFrame): void {
    for (const h of this.handlers) h(f);
  }
  acked(msgId: string): boolean {
    return this.sent.some(f => f.type === 'ack' && f.msgId === msgId);
  }
}

/** A Reporter double in --json mode, so stdout lines arrive as records. */
function fakeReporter(): { r: Reporter; lines: Record<string, unknown>[]; notes: string[] } {
  const lines: Record<string, unknown>[] = [];
  const notes: string[] = [];
  const r = {
    json: true,
    plain: true,
    line: (record: Record<string, unknown>) => lines.push(record),
    emit: (record: Record<string, unknown>) => lines.push(record),
    note: (text: string) => notes.push(text),
    status: () => {},
    done: () => {},
  } as unknown as Reporter;
  return { r, lines, notes };
}

// One ratchet pair for the whole file; messages are encrypted and delivered
// strictly in order, because that is what the ratchet requires and what the
// serialized frame queue in attachInbound guarantees in production.
const aliceStores = new FileStores('inb-alice');
const bobStores = new FileStores('inb-bob');
await generateAndStoreKeys(aliceStores);
const bobUpload = await generateAndStoreKeys(bobStores);
await establishSession(aliceStores, ALICE, bundleFrom(BOB, bobUpload));

const log = new MessageLog('inb-bob');

async function deliver(
  body: string,
  ws: FakeWs,
  r: Reporter,
  opts: { corrupt?: boolean; msgId?: string } = {},
): Promise<string> {
  const { msgType, payload } = await encryptText(aliceStores, ALICE, BOB, body);
  const msgId = opts.msgId ?? ulid();
  const inbound = attachInbound({
    name: 'inb-bob',
    userId: BOB,
    stores: bobStores,
    ws: ws as unknown as WsClient,
    report: r,
    log,
    consume: true,
  });
  ws.deliver({
    type: 'msg',
    from: ALICE,
    msgId,
    msgType,
    payload: opts.corrupt ? `${payload.slice(0, -8)}AAAAAAAA` : payload,
    ts: 4242,
  });
  await inbound.settled();
  return msgId;
}

/**
 * the design plan: the inbound policy is where "durable message log" either
 * holds or does not. Everything here drives real ciphertext through the real
 * decrypt path — the only fakes are the socket and the reporter, because the
 * properties under test are about ORDER and PERSISTENCE, not cryptography.
 */
describe('the inbound policy writes the log', () => {
  it('persists a plain message BEFORE the ack that deletes the server copy', async () => {
    const ws = new FakeWs();
    const { r, lines } = fakeReporter();
    let spoolAtAck: string | null = null;
    ws.onAck = () => {
      // The FIRST ack is the one that matters: the moment any ack leaves,
      // the server deletes its copy — a later ack repairing the picture
      // would hide exactly the crash window this test exists to close.
      if (spoolAtAck === null) {
        spoolAtAck = existsSync(log.path) ? readFileSync(log.path, 'utf8') : '';
      }
    };

    const msgId = await deliver('hello bob — first contact', ws, r);

    // Durable-then-delete: when the ack left, the record was already on disk.
    expect(ws.acked(msgId)).toBe(true);
    expect(spoolAtAck).not.toBeNull();
    expect(spoolAtAck).toContain(msgId);

    const [record] = log.read({ limit: 1 });
    expect(record).toMatchObject({
      id: msgId,
      dir: 'in',
      peer: ALICE,
      ts: 4242,
      tcm: '',
      text: 'hello bob — first contact',
      read: false,
    });
    // …and it still rendered to the stream, as listen always has.
    expect(lines.some(l => l.text === 'hello bob — first contact')).toBe(true);
  });

  it('stores the RENDERED form of a reply, never raw envelope JSON', async () => {
    const ws = new FakeWs();
    const { r } = fakeReporter();
    const msgId = await deliver('{"tcm":"reply","ref":"01ARZ3NDEKTSV4RRFFQ69G5FAV","ofs":false,"text":"on my way"}', ws, r);
    const [record] = log.read({ limit: 1 });
    expect(record).toMatchObject({ id: msgId, tcm: 'reply', text: 'on my way' });
    expect(readFileSync(log.path, 'utf8')).not.toContain('{\\"tcm\\"');
  });

  it('does NOT persist a vault announcement — or anything but conversation', async () => {
    const ws = new FakeWs();
    const { r, lines } = fakeReporter();
    const before = log.read().length;
    const msgId = await deliver(
      '{"tcm":"vault","op":"set","id":"01ARZ3NDEKTSV4RRFFQ69G5FAV","title":"Door code","body":"4211","n":1,"k":0}',
      ws,
      r,
    );
    // Consumed and shown ("store less" is about the DISK, not the stream)…
    expect(ws.acked(msgId)).toBe(true);
    expect(lines.some(l => l.text === '[vault item saved]')).toBe(true);
    // …but the spool gained nothing, and the secret is nowhere in it.
    expect(log.read().length).toBe(before);
    const spool = readFileSync(log.path, 'utf8');
    expect(spool).not.toContain('4211');
    expect(spool).not.toContain('Door code');
  });

  it('acks a carrier without logging it', async () => {
    const ws = new FakeWs();
    const { r } = fakeReporter();
    const before = log.read().length;
    const msgId = await deliver('{"tcm":"react","ref":"01ARZ3NDEKTSV4RRFFQ69G5FAV","ofs":false,"emoji":"+1"}', ws, r);
    expect(ws.acked(msgId)).toBe(true);
    expect(log.read().length).toBe(before);
  });

  it('stays silent on call signalling and logs nothing', async () => {
    const ws = new FakeWs();
    const { r, lines } = fakeReporter();
    const before = log.read().length;
    const msgId = await deliver('{"tcm":"call.offer","cid":"C1","sdp":"v=0"}', ws, r);
    expect(ws.acked(msgId)).toBe(true);
    expect(lines.length).toBe(0);
    expect(log.read().length).toBe(before);
  });

  it('records the display name a profile card carries, for contacts', async () => {
    const ws = new FakeWs();
    const { r } = fakeReporter();
    const before = log.read().length;
    await deliver('{"tcm":"profile","n":"CI — api-server","a":"","v":1}', ws, r);
    expect(bobStores.loadPeerNames()[ALICE]).toBe('CI — api-server');
    // A carrier still: named, acked, not a log record.
    expect(log.read().length).toBe(before);
  });

  it('does not duplicate a redelivered message in the log', async () => {
    const ws = new FakeWs();
    const { r } = fakeReporter();
    const msgId = await deliver('redelivery target', ws, r);
    const count = log.read().length;
    // Same frame again (a lost ack): acked again, logged once.
    const ws2 = new FakeWs();
    const inbound = attachInbound({
      name: 'inb-bob',
      userId: BOB,
      stores: bobStores,
      ws: ws2 as unknown as WsClient,
      report: r,
      log,
      consume: true,
    });
    ws2.deliver({ type: 'msg', from: ALICE, msgId, msgType: 'ciphertext', payload: 'AAAA', ts: 1 });
    await inbound.settled();
    expect(ws2.acked(msgId)).toBe(true);
    expect(log.read().length).toBe(count);
  });

  it('FAILS CLOSED when the spool cannot be written: no ack, loud, still shown', async () => {
    const ws = new FakeWs();
    const { r, lines, notes } = fakeReporter();
    chmodSync(log.path, 0o400); // an append can no longer succeed
    try {
      const msgId = await deliver('must not be silently lost', ws, r);
      // The server row is left alone — an ack would delete the only copy on
      // the strength of a write that did not happen.
      expect(ws.acked(msgId)).toBe(false);
      expect(bobStores.hasSeen(msgId)).toBe(false);
      expect(notes.some(n => n.includes('NOT acking'))).toBe(true);
      // The plaintext this process holds is shown before it is lost.
      expect(lines.some(l => l.unlogged === true && l.text === 'must not be silently lost')).toBe(
        true,
      );
    } finally {
      chmodSync(log.path, 0o600);
    }
  });

  it('rejects tampered ciphertext loudly, acks it, and logs nothing', async () => {
    const ws = new FakeWs();
    const { r, notes } = fakeReporter();
    const before = log.read().length;
    const msgId = await deliver('tamper target sentence', ws, r, { corrupt: true });
    expect(ws.acked(msgId)).toBe(true); // purge the poison row
    expect(log.read().length).toBe(before);
    expect(readFileSync(log.path, 'utf8')).not.toContain('tamper target sentence');
    expect(notes.some(n => n.includes('DECRYPT FAILED'))).toBe(true);
  });
});

/**
 * An earlier review — plain `listen` owes the same line-ownership guarantee the
 * calls daemon was given in an earlier revision, and it is the path that carries MORE
 * traffic.
 *
 * An earlier revision found that a peer body of `hello\nGCALL leg_dial …` printed a
 * second line under a single leading `[peer] ` that was byte-identical to one
 * this program emits itself — enough to sanction a cid of the peer's choosing
 * in front of the e2e gate's provenance scanner, a log shipper, or an operator
 * grepping the stream during an incident. The fix was applied to
 * call-session.ts and nowhere else. These three print sites — the ordinary
 * chat line, the carrier note, and the quarantine fallback that is the LAST
 * copy of a plaintext — kept printing `[${shownFrom}] ${rendered.text}` raw.
 *
 * Reverts that must make this block red: drop `prefixLines` from any of the
 * three sites in inbound.ts.
 */
describe('an earlier revision — plain listen cannot be made to write this program’s own lines', () => {
  /** The e2e gate's provenance anchors, Unicode-aware. */
  const MACHINE = /^(GCALL|CALL) /m;

  /**
   * A Reporter double in HUMAN mode. `fakeReporter` above runs `--json`, where
   * the record is the output and the human string is discarded — which is
   * exactly why this defect survived a suite that only ever looked at records.
   */
  function humanReporter(): { r: Reporter; out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    const r = {
      json: false,
      plain: true,
      line: (_record: Record<string, unknown>, human: string) => out.push(human),
      emit: (_record: Record<string, unknown>, human: string) => out.push(human),
      note: (text: string) => err.push(text),
      status: () => {},
      done: () => {},
    } as unknown as Reporter;
    return { r, out, err };
  }

  /** What a consumer reads: both streams, joined the way a terminal joins them. */
  const stream = (out: string[], err: string[]): string => [...out, ...err].join('\n');

  it('a multi-line chat body writes no line that starts with a machine prefix', async () => {
    const forged = `GCALL leg_dial to=${BOB} cid=01BX5ZZKBKACTAV9WEVGEMMVRZ kind=ginvite`;
    const ws = new FakeWs();
    const { r, out, err } = humanReporter();
    await deliver(`hello\n${forged}`, ws, r);

    expect(
      MACHINE.test(stream(out, err)),
      'a peer wrote a line plain `listen` presents as this program’s own signalling',
    ).toBe(false);
    // …and the message is still WHOLE, every line owned by the sender.
    expect(stream(out, err).split('\n')).toContain(`[${ALICE}] hello`);
    expect(stream(out, err).split('\n')).toContain(`[${ALICE}] ${forged}`);
  });

  it('a U+2028 chat body writes no machine line either', async () => {
    const forged = 'CALL connected cid=01BX5ZZKBKACTAV9WEVGEMMVRZ';
    const ws = new FakeWs();
    const { r, out, err } = humanReporter();
    await deliver(`hello\u2028${forged}`, ws, r);

    expect(MACHINE.test(stream(out, err))).toBe(false);
    expect(stream(out, err).split('\n')).toContain(`[${ALICE}] ${forged}`);
  });

  it('the CARRIER note on stderr is prefixed on every line too', async () => {
    // stderr is not the safer stream: a log shipper reads both, and the
    // carrier line interpolates the same peer-chosen text.
    const ws = new FakeWs();
    const { r, out, err } = humanReporter();
    await deliver(JSON.stringify({ tcm: 'react', emoji: 'x\nCALL busy' }), ws, r);

    expect(MACHINE.test(stream(out, err))).toBe(false);
    expect(err.join('\n').split('\n')).toContain(`[${ALICE}] (react) reaction x`);
    expect(err.join('\n').split('\n')).toContain(`[${ALICE}] (react) CALL busy`);
  });

  it('the quarantine fallback — the LAST copy — is prefixed on every line', async () => {
    // This print exists because the spool write failed and the line is the
    // only remaining copy of the plaintext: the one site where losing content
    // is unacceptable AND the one an attacker most wants to forge on.
    const forged = 'GCALL released sid=01BX5ZZKBKACTAV9WEVGEMMVRZ';
    const ws = new FakeWs();
    const { r, out, err } = humanReporter();
    chmodSync(log.path, 0o400); // an append can no longer succeed
    let msgId: string;
    try {
      msgId = await deliver(`the last copy\n${forged}`, ws, r);
    } finally {
      chmodSync(log.path, 0o600);
    }

    expect(MACHINE.test(stream(out, err))).toBe(false);
    expect(out.join('\n').split('\n')).toContain(`[${ALICE}] the last copy`);
    expect(out.join('\n').split('\n')).toContain(`[${ALICE}] ${forged}`);
    // The prefix changes nothing about the fail-closed contract.
    expect(ws.acked(msgId)).toBe(false);
  });

  it('a legitimate multi-line message survives WHOLE, emoji and RTL intact', async () => {
    const body = 'build failed ❌ 👩🏽‍🚀\n\nmake: *** [all] Error 1\nثانية: كل شيء بخير';
    const ws = new FakeWs();
    const { r, out } = humanReporter();
    await deliver(body, ws, r);

    const lines = out.join('\n').split('\n');
    const expected = body.split('\n').map(l => `[${ALICE}] ${l}`);
    const start = lines.indexOf(expected[0]!);
    expect(start, 'the message did not render at all').toBeGreaterThanOrEqual(0);
    expect(lines.slice(start, start + expected.length)).toEqual(expected);
  });

  it('a single-line message is byte-identical to what listen always printed', async () => {
    const ws = new FakeWs();
    const { r, out } = humanReporter();
    await deliver('hello bob — ordinary traffic', ws, r);
    expect(out).toContain(`[${ALICE}] hello bob — ordinary traffic`);
  });
});

describe('watchQuiet (the sync drain)', () => {
  it('holds until the queue has been silent for the window', async () => {
    const ws = new FakeWs();
    const quiet = watchQuiet(ws as unknown as WsClient);
    const started = Date.now();
    let lastFrameAt = started;
    // Frames trickle in; each one must push the deadline out.
    for (const delay of [40, 80, 120]) {
      setTimeout(() => {
        lastFrameAt = Date.now();
        ws.deliver({ type: 'msg', from: ALICE, msgId: ulid(), msgType: 'ciphertext', payload: 'AA', ts: 1 });
      }, delay);
    }
    await quiet.wait(200);
    const elapsed = Date.now() - lastFrameAt;
    // Resolved only after ≥200ms of silence FOLLOWING the last frame — not
    // 200ms after start, which is what a watcher that ignores frames gives.
    expect(elapsed).toBeGreaterThanOrEqual(180);
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
  });

  it('returns promptly when nothing arrives at all', async () => {
    const ws = new FakeWs();
    const quiet = watchQuiet(ws as unknown as WsClient);
    const started = Date.now();
    await quiet.wait(100);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(1000);
  });

  it('ignores receipts — only msg frames reset the clock', async () => {
    const ws = new FakeWs();
    const quiet = watchQuiet(ws as unknown as WsClient);
    const started = Date.now();
    const timer = setInterval(() => {
      ws.deliver({ type: 'receipt', msgId: ulid(), state: 'sent' });
    }, 30);
    await quiet.wait(150);
    clearInterval(timer);
    // A stream of receipts must not hold sync open forever.
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
