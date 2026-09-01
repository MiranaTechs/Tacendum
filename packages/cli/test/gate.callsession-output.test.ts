/**
 * An earlier review — CallSession's operator output for SERVER-CHOSEN strings.
 *
 * `frame.from`, `frame.code` and `frame.detail` are plain `z.string()` in
 * packages/shared — unbounded, unnormalized, chosen by the server. The failure
 * lines in `CallSession.onMessage` already printed them through
 * `sanitizeServerField`, but the SUCCESS-path chat prints (the final line, the
 * non-call-transport line behind `wasCall`, and the quarantine fallback) and
 * the error-frame branch interpolated the raw values — so C1 control bytes,
 * terminal escapes and megabyte fields reached the daemon's terminal on
 * exactly the lines a healthy deployment prints most. inbound.ts sanitizes
 * every one of its mirrored prints; these tests pin the calls daemon to the
 * same rule, one test per print site.
 *
 * Reverts that must make this file red: interpolate raw `frame.from` at any
 * of the three `console.log` sites, or print `frame.code`/`frame.detail`
 * unbounded (or bound both at the same limit — the code stops at 64, the
 * detail at 200, and the fixtures overrun both).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monotonicFactory } from 'ulid';
import type { PrekeyBundle, ServerFrame } from '@tacendum/shared';

const { wsInstances } = vi.hoisted(() => ({
  wsInstances: [] as Array<{
    handlers: Record<string, Array<(...a: unknown[]) => void>>;
    sent: string[];
  }>,
}));

vi.mock('ws', () => {
  // Enough of `ws` for CallSession.connect(): record the instance, open on the
  // next tick, capture outgoing frames, and expose the handlers so a test can
  // push server frames through the REAL WsClient parse path.
  class FakeWebSocket {
    handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
    sent: string[] = [];
    constructor(_url: string) {
      wsInstances.push(this);
      setTimeout(() => {
        for (const h of this.handlers.open ?? []) h();
      }, 0);
    }
    on(event: string, cb: (...a: unknown[]) => void) {
      (this.handlers[event] ??= []).push(cb);
      return this;
    }
    off(event: string, cb: (...a: unknown[]) => void) {
      this.handlers[event] = (this.handlers[event] ?? []).filter(h => h !== cb);
      return this;
    }
    removeAllListeners() {
      this.handlers = {};
      return this;
    }
    close() {}
    send(data: string) {
      this.sent.push(data);
    }
  }
  return { default: FakeWebSocket };
});

// Set BEFORE the src imports: config.ts snapshots the env at module evaluation.
const home = mkdtempSync(join(tmpdir(), 'tacendum-callout-'));
const previousHome = process.env.TACENDUM_HOME;
const previousApi = process.env.TACENDUM_API;
process.env.TACENDUM_HOME = home;
process.env.TACENDUM_API = 'http://callout.test';

const { FileStores } = await import('../src/stores.js');
const { generateAndStoreKeys, establishSession, encryptText } = await import('../src/messaging.js');
const { CallSession } = await import('../src/call-session.js');
const { MessageLog } = await import('../src/msglog.js');
const { saveProfile } = await import('../src/profile.js');
const { sanitizeServerField } = await import('../src/render.js');
type FileStoresT = InstanceType<typeof FileStores>;

const ulid = monotonicFactory();
const realFetch = globalThis.fetch;

const BOT = 'callout-bot';
const BOT_ID = `01${'CALLQBOT'.repeat(3)}`;

/**
 * The `from` a hostile server asserts: C0 bytes (ESC, BEL), DEL, a C1 CSI
 * introducer, and enough length to overrun the 64-byte display bound. The
 * decrypt path takes it byte-exact (it is the ProtocolAddress the evil peer
 * really used), so a message from this address decrypts fine — the only
 * question is what the terminal is shown.
 */
const EVIL_ID = `01EV\u001b[31mIL\u0007\u007f\u009b]PEER${'X'.repeat(70)}`;
const SHOWN_EVIL = sanitizeServerField(EVIL_ID);
/**
 * The rule assumes a control character in a pattern is a typo. Here the
 * control characters ARE the assertion — this constant exists to catch one
 * reaching a terminal, so a pattern that could not name them could not fail.
 * Same disable, same reason, as render.ts's `LINE_BREAK`.
 */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/;

function bundleFrom(
  userId: string,
  upload: Awaited<ReturnType<typeof generateAndStoreKeys>>,
  otkIndex: number,
): PrekeyBundle {
  return {
    userId,
    registrationId: upload.registrationId,
    identityKey: upload.identityKey,
    signedPrekey: upload.signedPrekey,
    kyberPrekey: upload.kyberPrekey,
    oneTimePrekey: upload.oneTimePrekeys[otkIndex],
  };
}

let session: InstanceType<typeof CallSession>;
let socket: (typeof wsInstances)[number];
let botStores: FileStoresT;
let evilStores: FileStoresT;
let stdout: string[];
let stderr: string[];

beforeAll(async () => {
  botStores = new FileStores(BOT);
  const botUpload = await generateAndStoreKeys(botStores);
  saveProfile({
    name: BOT,
    identityKey: botUpload.identityKey,
    userId: BOT_ID,
    authToken: 'live-callout-bot',
    registrationId: botUpload.registrationId,
    deviceId: 1,
  });

  // The evil peer is a REAL correspondent — same bootstrap as any first
  // contact — whose only hostility is the id the server relays for it.
  evilStores = new FileStores('callout-evil-peer');
  await generateAndStoreKeys(evilStores);
  await establishSession(evilStores, EVIL_ID, bundleFrom(BOT_ID, botUpload, 0));

  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = String(input).replace('http://callout.test', '');
    if (path === '/v1/ws-ticket') {
      return new Response(JSON.stringify({ ticket: 'tkt', expiresAt: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected request ${path}`);
  }) as typeof fetch;

  // Both streams are assertion targets: chat lines land on stdout, warnings
  // and the error-frame print on stderr.
  stdout = [];
  stderr = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    stdout.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr.push(args.map(String).join(' '));
  });

  session = new CallSession(BOT);
  await session.connect();
  socket = wsInstances[wsInstances.length - 1]!;
}, 30000);

afterAll(() => {
  session.close();
  vi.restoreAllMocks();
  globalThis.fetch = realFetch;
  if (previousHome === undefined) delete process.env.TACENDUM_HOME;
  else process.env.TACENDUM_HOME = previousHome;
  if (previousApi === undefined) delete process.env.TACENDUM_API;
  else process.env.TACENDUM_API = previousApi;
});

function deliver(frame: ServerFrame): void {
  for (const h of socket.handlers.message ?? []) h(JSON.stringify(frame));
}

function acked(msgId: string): boolean {
  return socket.sent.some(f => {
    const parsed = JSON.parse(f) as { type: string; msgId?: string };
    return parsed.type === 'ack' && parsed.msgId === msgId;
  });
}

async function sendFromEvil(text: string): Promise<{ msgType: 'prekey' | 'ciphertext'; payload: string }> {
  return encryptText(evilStores, EVIL_ID, BOT_ID, text);
}

describe('an earlier revision — every CallSession print of a server field is stripped and bounded', () => {
  // The fixture id must actually exercise both halves of sanitizeServerField,
  // or the assertions below prove nothing.
  it('the fixture overruns the bound and carries control bytes', () => {
    expect(EVIL_ID).toMatch(CONTROL);
    expect(SHOWN_EVIL).not.toMatch(CONTROL);
    expect(SHOWN_EVIL.endsWith('…')).toBe(true);
    expect(SHOWN_EVIL.length).toBe(65); // 64 + the ellipsis
  });

  it('the final success print (plain chat) shows the sanitized from', async () => {
    const { msgType, payload } = await sendFromEvil('hello there');
    const msgId = ulid();
    const before = stdout.length;

    deliver({ type: 'msg', from: EVIL_ID, msgId, msgType, payload, ts: Date.now() });
    await vi.waitFor(() => expect(acked(msgId)).toBe(true), { timeout: 10000 });

    const lines = stdout.slice(before);
    expect(lines).toContain(`[${SHOWN_EVIL}] hello there`);
    for (const line of lines) expect(line).not.toMatch(CONTROL);
  }, 30000);

  it('a structured non-call body prints as chat, through the same sanitizer', async () => {
    // Starts with the envelope sentinel, but it is a reply, not call
    // transport, so it must be printed like chat and through the same
    // sanitizer that every other line here goes through.
    const { msgType, payload } = await sendFromEvil('{"tcm":"reply","text":"a reply"}');
    const msgId = ulid();
    const before = stdout.length;

    deliver({ type: 'msg', from: EVIL_ID, msgId, msgType, payload, ts: Date.now() });
    await vi.waitFor(() => expect(acked(msgId)).toBe(true), { timeout: 10000 });

    const lines = stdout.slice(before);
    expect(lines).toContain(`[${SHOWN_EVIL}] a reply`);
    // THE KNOWN RAW SITE IS GONE, so the filter that used to stand here is
    // gone with it. `CallRunner.emit` printed `CALL unsupported from=<raw
    // peerId>` for this exact frame — the call-session boundary could not
    // sanitize it, because `onBody` needs the byte-exact address for routing —
    // and the note that recorded it said: when call.ts stops printing it,
    // delete the filter and let the scan cover every line. That happened
    // (the namespace, not the parse, decides what the call runner claims,
    // and a non-`call.` body is not its business at all), so
    // this is now the whole-output assertion it was always meant to be.
    expect(lines.some(l => l.startsWith('CALL '))).toBe(false);
    for (const line of lines) expect(line).not.toMatch(CONTROL);
  }, 30000);

  it('the quarantine-fallback print shows the sanitized from, and still does not ack', async () => {
    const spy = vi.spyOn(MessageLog.prototype, 'append').mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device');
    });
    try {
      const { msgType, payload } = await sendFromEvil('the last copy');
      const msgId = ulid();
      const beforeOut = stdout.length;
      const beforeErr = stderr.length;

      deliver({ type: 'msg', from: EVIL_ID, msgId, msgType, payload, ts: Date.now() });
      await vi.waitFor(() => expect(stdout.length).toBeGreaterThan(beforeOut), { timeout: 10000 });

      expect(stdout.slice(beforeOut)).toContain(`[${SHOWN_EVIL}] the last copy`);
      for (const line of stdout.slice(beforeOut)) expect(line).not.toMatch(CONTROL);
      expect(stderr.slice(beforeErr).some(l => l.includes('message log write failed'))).toBe(true);
      // The fallback print changes nothing about the fail-closed contract.
      expect(acked(msgId)).toBe(false);
      expect(botStores.hasSeen(msgId)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  }, 30000);

  it('the error-frame print bounds the code at 64 and the detail at 200, both stripped', async () => {
    // Each field overruns ITS OWN bound, so a fix that bounded both at the
    // default 64 — or neither — fails this equality.
    const code = `not_ok\u001b[2J${'C'.repeat(100)}`;
    const detail = `broke\u009b${'D'.repeat(300)}\r\nforged: second line`;
    const before = stderr.length;

    deliver({ type: 'error', code, detail });
    await vi.waitFor(() => expect(stderr.length).toBeGreaterThan(before), { timeout: 10000 });

    const line = stderr.slice(before).find(l => l.startsWith('server error:'));
    expect(line).toBe(
      `server error: ${sanitizeServerField(code, 64)}: ${sanitizeServerField(detail, 200)}`,
    );
    expect(line).not.toMatch(CONTROL);
    expect(sanitizeServerField(detail, 200).length).toBeGreaterThan(65);
  }, 30000);
});

describe('an earlier revision — the mirror obeys the rules attachInbound obeys', () => {
  // Every one of these shipped green because the rule was written at the call
  // sites and only the `listen` side was pinned. The audit that found them
  // measured each on both paths; these pin the CallSession side, which is the
  // side that kept diverging.

  it('a carrier goes to stderr with its kind, never to stdout as chat', async () => {
    // render.ts's rule: a carrier is a state change and is "never on stdout".
    // attachInbound obeys it. This path printed every non-empty body to stdout
    // untagged, so a reaction reached a `listen --calls` consumer as
    // `[peer] reaction x` — indistinguishable from the peer typing it, and
    // read as conversation by anything parsing stdout.
    const { msgType, payload } = await sendFromEvil('{"tcm":"react","emoji":"x"}');
    const msgId = ulid();
    const beforeOut = stdout.length;
    const beforeErr = stderr.length;

    deliver({ type: 'msg', from: EVIL_ID, msgId, msgType, payload, ts: Date.now() });
    await vi.waitFor(() => expect(acked(msgId)).toBe(true), { timeout: 10000 });

    const out = stdout.slice(beforeOut).filter(l => !l.startsWith('CALL '));
    const err = stderr.slice(beforeErr);
    expect(
      err.some(l => l.includes(`[${SHOWN_EVIL}] (react)`)),
      'the carrier was not announced on stderr with its kind',
    ).toBe(true);
    expect(
      out.some(l => l.includes('reaction')),
      'a carrier reached stdout, where a consumer reads it as a line of chat',
    ).toBe(false);
  }, 30000);

  it('a profile card is RECORDED before it is acked away', async () => {
    // The ack destroys the server's only copy and the ratchet refuses
    // redelivery, so a card dropped here is a durable fact destroyed: a
    // calls-only bot could never learn any peer's display name, and the
    // pairing confirmation the card exists for could never complete.
    const { msgType, payload } = await sendFromEvil('{"tcm":"profile","n":"Evil Prime"}');
    const msgId = ulid();

    deliver({ type: 'msg', from: EVIL_ID, msgId, msgType, payload, ts: Date.now() });
    await vi.waitFor(() => expect(acked(msgId)).toBe(true), { timeout: 10000 });

    expect(
      botStores.loadPeerNames()[EVIL_ID],
      'the card was consumed and acked without recording the name it carried',
    ).toBe('Evil Prime');
  }, 30000);
});

/**
 * An earlier review — A LINE THAT BEGINS WITH A MACHINE PREFIX IS THIS PROGRAM'S
 * OWN WORD, and a remote peer's message may not impersonate it.
 *
 * `rendered.text` is the peer's decrypted plaintext. `sanitizeForTerminal`
 * strips ESC, CR and the rest of C0/C1 from it, but it deliberately KEEPS LF,
 * because a multi-line message is a feature. So the body
 * `hello\nGCALL leg_dial …` used to print two lines here, and the second was
 * byte-identical to a line this program emits itself. The e2e gate's
 * provenance scanner anchors on `^GCALL ` and `^CALL `; a peer who can write
 * those lines can sanction a cid of their own choosing, and the scanner then
 * accepts a real `call.end` on it. That was reproduced — rc=0, no findings.
 *
 * The gate is only the loudest consumer. A log shipper, and an operator
 * grepping this stream during an incident, are entitled to the same guarantee.
 *
 * Reverts that must make this block red: print `rendered.text` without
 * `prefixLines` at any of the three peer-text print sites (the chat line, the
 * carrier line, the quarantine fallback).
 */
describe('an earlier revision — a peer cannot forge this program’s own machine lines', () => {
  /** The anchors the gate's provenance scanner uses. */
  const MACHINE = /^(GCALL|CALL) /;

  /** What a consumer actually reads: one entry per LINE, not per print call. */
  function linesSince(outFrom: number, errFrom: number): string[] {
    return [...stdout.slice(outFrom), ...stderr.slice(errFrom)].flatMap(l => l.split('\n'));
  }

  it('a multi-line chat body writes no line that starts with a machine prefix', async () => {
    const forgedCid = ulid();
    const forged = `GCALL leg_dial to=${BOT_ID} cid=${forgedCid} kind=ginvite`;
    const { msgType, payload } = await sendFromEvil(`hello\n${forged}`);
    const msgId = ulid();
    const beforeOut = stdout.length;
    const beforeErr = stderr.length;

    deliver({ type: 'msg', from: EVIL_ID, msgId, msgType, payload, ts: Date.now() });
    await vi.waitFor(() => expect(acked(msgId)).toBe(true), { timeout: 10000 });

    const lines = linesSince(beforeOut, beforeErr);
    expect(
      lines.filter(l => MACHINE.test(l)),
      'the peer wrote a line the gate reads as this program’s own signalling',
    ).toEqual([]);
    // …and the message is still WHOLE: both of its lines, each on its own
    // line, each owned by the sender that sent them.
    expect(lines).toContain(`[${SHOWN_EVIL}] hello`);
    expect(lines).toContain(`[${SHOWN_EVIL}] ${forged}`);
  }, 30000);

  it('a multi-line CARRIER body writes no line that starts with a machine prefix', async () => {
    // The carrier path prints on stderr with its kind, and it interpolates the
    // same peer-chosen text: `str()` bounds a reaction's emoji at 16 chars and
    // strips its control bytes, but LF survives there too.
    const forged = 'GCALL released';
    const { msgType, payload } = await sendFromEvil(
      JSON.stringify({ tcm: 'react', emoji: `x\n${forged}` }),
    );
    const msgId = ulid();
    const beforeOut = stdout.length;
    const beforeErr = stderr.length;

    deliver({ type: 'msg', from: EVIL_ID, msgId, msgType, payload, ts: Date.now() });
    await vi.waitFor(() => expect(acked(msgId)).toBe(true), { timeout: 10000 });

    const lines = linesSince(beforeOut, beforeErr);
    expect(
      lines.filter(l => MACHINE.test(l)),
      'a carrier let the peer write this program’s own signalling',
    ).toEqual([]);
    expect(lines).toContain(`[${SHOWN_EVIL}] (react) reaction x`);
    expect(lines).toContain(`[${SHOWN_EVIL}] (react) ${forged}`);
  }, 30000);

  it('the quarantine fallback — the LAST copy — is prefixed on every line too', async () => {
    // This print exists because the spool write failed and the line is the only
    // remaining copy of the plaintext. That makes it the one site where losing
    // content is unacceptable AND the one an attacker most wants to forge on.
    const spy = vi.spyOn(MessageLog.prototype, 'append').mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device');
    });
    try {
      const forged = `CALL recv tcm=call.end from=${BOT_ID} cid=${ulid()}`;
      const { msgType, payload } = await sendFromEvil(`the last copy\n${forged}`);
      const msgId = ulid();
      const beforeOut = stdout.length;
      const beforeErr = stderr.length;

      deliver({ type: 'msg', from: EVIL_ID, msgId, msgType, payload, ts: Date.now() });
      await vi.waitFor(() => expect(stdout.length).toBeGreaterThan(beforeOut), { timeout: 10000 });

      const lines = linesSince(beforeOut, beforeErr);
      expect(lines.filter(l => MACHINE.test(l))).toEqual([]);
      expect(lines).toContain(`[${SHOWN_EVIL}] the last copy`);
      expect(lines).toContain(`[${SHOWN_EVIL}] ${forged}`);
      expect(acked(msgId)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  }, 30000);

  it('a legitimate multi-line message survives WHOLE, in order, nothing dropped', async () => {
    // The fix must not be a flattener, an escaper or a truncator: a peer who
    // pastes a stack trace is doing the ordinary thing this product supports.
    const body = 'line one\nline two\n\nline four with  spaces\ttab';
    const { msgType, payload } = await sendFromEvil(body);
    const msgId = ulid();
    const beforeOut = stdout.length;
    const beforeErr = stderr.length;

    deliver({ type: 'msg', from: EVIL_ID, msgId, msgType, payload, ts: Date.now() });
    await vi.waitFor(() => expect(acked(msgId)).toBe(true), { timeout: 10000 });

    const lines = linesSince(beforeOut, beforeErr);
    const expected = body.split('\n').map(l => `[${SHOWN_EVIL}] ${l}`);
    const start = lines.indexOf(expected[0]!);
    expect(start, 'the message did not render at all').toBeGreaterThanOrEqual(0);
    expect(lines.slice(start, start + expected.length)).toEqual(expected);
  }, 30000);

  it('ESC and CR never reach the stream — the prefix is worthless if a peer can erase it', async () => {
    // The neighbouring attack: a prefix that can be overwritten is no prefix.
    // `renderBody` already routes every peer body through
    // `sanitizeForTerminal`, which drops ESC (1B), CR (0D) and the rest of
    // C0/C1/DEL while keeping TAB and LF. This pins that upstream rule from
    // the consumer's side, so a change there that let CR through is caught
    // here — a lone CR returns the cursor to column 0 and repaints the line
    // the prefix was just written on.
    const { msgType, payload } = await sendFromEvil(
      'visible\u001b[2K\rGCALL released sid=x\u0007 tail',
    );
    const msgId = ulid();
    const beforeOut = stdout.length;
    const beforeErr = stderr.length;

    deliver({ type: 'msg', from: EVIL_ID, msgId, msgType, payload, ts: Date.now() });
    await vi.waitFor(() => expect(acked(msgId)).toBe(true), { timeout: 10000 });

    const lines = linesSince(beforeOut, beforeErr);
    for (const line of lines) expect(line).not.toMatch(CONTROL);
    expect(lines.filter(l => MACHINE.test(l))).toEqual([]);
    expect(lines).toContain(`[${SHOWN_EVIL}] visible[2KGCALL released sid=x tail`);
  }, 30000);
});

/**
 * An earlier review — the SAME rule, against the breaks an earlier revision did not count.
 *
 * An earlier revision's helper split on `/\r\n|[\n\r]/`, and its regression test split the
 * captured output on `'\n'`. Both looked at the same two characters, so the
 * test could not see what the helper missed: U+2028 LINE SEPARATOR and U+2029
 * PARAGRAPH SEPARATOR are hard line boundaries in Unicode AND in ECMAScript's
 * own multiline anchors, `sanitizeForTerminal` has no reason to strip them
 * (they are not control bytes), and the earlier helper passed them through
 * into the middle of a "line" that a JS log processor, a Python `splitlines`
 * consumer or an editor then reads as two. A peer body of
 * `hello<U+2028>GCALL leg_dial …` still put an unprefixed machine line on this
 * client's stream for every one of them.
 *
 * So the assertions here are deliberately UNICODE-AWARE — `/^(GCALL|CALL) /m`
 * over the joined output, not a `'\n'` split — because the `'\n'` split is
 * precisely what hid this for a round.
 *
 * Reverts that must make this block red: narrow `prefixLines`' break set back
 * to CR and LF, or stop flattening the breaks out of a server field.
 */
describe('an earlier revision — a peer cannot forge a machine line with a Unicode separator', () => {
  /**
   * What a UNICODE-AWARE consumer reads. `/^…/m` is the anchor, applied to the
   * whole stream joined by LF: if any line boundary the consumer honours is
   * followed by a machine prefix, this matches — whichever character made the
   * boundary, including one this test never thought of.
   */
  const MACHINE_ANYWHERE = /^(GCALL|CALL) /m;

  function streamSince(outFrom: number, errFrom: number): string {
    return [...stdout.slice(outFrom), ...stderr.slice(errFrom)].join('\n');
  }

  it('a U+2028 chat body writes no machine line — the ECMAScript anchor sees none', async () => {
    const forgedCid = ulid();
    const forged = `GCALL leg_dial to=${BOT_ID} cid=${forgedCid} kind=ginvite`;
    const { msgType, payload } = await sendFromEvil(`hello\u2028${forged}`);
    const msgId = ulid();
    const beforeOut = stdout.length;
    const beforeErr = stderr.length;

    deliver({ type: 'msg', from: EVIL_ID, msgId, msgType, payload, ts: Date.now() });
    await vi.waitFor(() => expect(acked(msgId)).toBe(true), { timeout: 10000 });

    const stream = streamSince(beforeOut, beforeErr);
    expect(
      MACHINE_ANYWHERE.test(stream),
      'a U+2028 in the body ended this program’s prefix and started the peer’s own line',
    ).toBe(false);
    // …and the message is still WHOLE: the separator became a real line, and
    // the line is the sender's.
    expect(stream.split('\n')).toContain(`[${SHOWN_EVIL}] hello`);
    expect(stream.split('\n')).toContain(`[${SHOWN_EVIL}] ${forged}`);
  }, 30000);

  it('a U+2029 CARRIER body writes no machine line either', async () => {
    // stderr is not the safer stream: a log shipper reads both, and `str()`
    // bounds a reaction's emoji without touching a separator.
    const forged = 'GCALL released sid=01BX5ZZKBKACTAV9WEVGEMMVRZ';
    const { msgType, payload } = await sendFromEvil(
      JSON.stringify({ tcm: 'react', emoji: `x\u2029${forged}` }),
    );
    const msgId = ulid();
    const beforeOut = stdout.length;
    const beforeErr = stderr.length;

    deliver({ type: 'msg', from: EVIL_ID, msgId, msgType, payload, ts: Date.now() });
    await vi.waitFor(() => expect(acked(msgId)).toBe(true), { timeout: 10000 });

    const stream = streamSince(beforeOut, beforeErr);
    expect(MACHINE_ANYWHERE.test(stream)).toBe(false);
    expect(stream.split('\n')).toContain(`[${SHOWN_EVIL}] (react) reaction x`);
  }, 30000);

  it('a SERVER field cannot end its own line — the July finding, in Unicode', async () => {
    // `sanitizeServerField`'s comment records the July 2026 round: a hostile
    // server forged a second `error: …` line on stderr under this CLI's own
    // prefix, and the remedy was to flatten CR and LF. U+2028 walked straight
    // through that remedy, so the same forgery worked again — this time
    // against every reader that honours a Unicode line break.
    const detail = 'broke\u2028server error: forged: the server said this';
    const before = stderr.length;

    deliver({ type: 'error', code: 'not_ok', detail });
    await vi.waitFor(() => expect(stderr.length).toBeGreaterThan(before), { timeout: 10000 });

    const stream = stderr.slice(before).join('\n');
    expect(
      /^server error: forged: /m.test(stream),
      'the server wrote a second `server error:` line under the CLI’s own prefix',
    ).toBe(false);
    expect(stream.split('\n')).toContain(
      'server error: not_ok: broke server error: forged: the server said this',
    );
  }, 30000);

  it('a legitimate multi-line message with emoji and RTL text survives WHOLE', async () => {
    // The non-regression half. Widening the break set must not start splitting
    // graphemes, reordering a bidi run, or dropping a surrogate pair.
    const body = 'déploiement ✅ 👩🏽‍🚀\nثانية: كل شيء بخير\nȩ́ combining, and a\ttab';
    const { msgType, payload } = await sendFromEvil(body);
    const msgId = ulid();
    const beforeOut = stdout.length;
    const beforeErr = stderr.length;

    deliver({ type: 'msg', from: EVIL_ID, msgId, msgType, payload, ts: Date.now() });
    await vi.waitFor(() => expect(acked(msgId)).toBe(true), { timeout: 10000 });

    const lines = streamSince(beforeOut, beforeErr).split('\n');
    const expected = body.split('\n').map(l => `[${SHOWN_EVIL}] ${l}`);
    const start = lines.indexOf(expected[0]!);
    expect(start, 'the message did not render at all').toBeGreaterThanOrEqual(0);
    expect(lines.slice(start, start + expected.length)).toEqual(expected);
  }, 30000);
});

