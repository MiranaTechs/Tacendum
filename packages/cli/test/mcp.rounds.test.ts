import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'tacendum-mcp-rounds-'));
process.env.TACENDUM_HOME = home;

const { saveProfile } = await import('../src/profile.js');
const { MessageLog, REDACT_AFTER_MS } = await import('../src/msglog.js');
const { McpServer, BODY_CAP_BYTES } = await import('../src/mcp.js');
type MessageRecord = import('../src/msglog.js').MessageRecord;

const USER_ID = '01AGENTAGENTAGENTAGENTAGEN';
const PEER = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const ROOM = '01GRPGRPGRPGRPGRPGRPGRPGRP';
const RM = '01MMMMMMMMMMMMMMMMMMMMMMMM';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type McpPayload = any;

let seq = 0;
function rec(over: Partial<MessageRecord> = {}): MessageRecord {
  seq += 1;
  return {
    id: `01HXXXXXXXXXXXXXXXXXX${String(seq).padStart(5, '0')}`,
    dir: 'in',
    peer: PEER,
    ts: 1000 + seq,
    tcm: '',
    text: `text ${seq}`,
    read: false,
    ...over,
  };
}

function makeAccount(name: string): InstanceType<typeof MessageLog> {
  saveProfile({
    name,
    identityKey: 'IDKEYMARKERBASE64SECRET==',
    userId: USER_ID,
    authToken: 'tok-SECRET-DO-NOT-EMIT',
    registrationId: 7,
    deviceId: 1,
  });
  return new MessageLog(name);
}

let nextId = 1;
async function read(name: string): Promise<McpPayload> {
  const id = nextId++;
  const raw = await new McpServer(name).handleLine(
    JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: 'tacendum_read_messages', arguments: {} },
    }),
  );
  const frame = JSON.parse(raw as string) as McpPayload;
  expect(frame.error).toBeUndefined();
  expect(frame.result.isError).toBeUndefined();
  return frame.result.structuredContent;
}

/**
 * task 6 (§3.7) — what a machine reader is handed when a
 * message has a detail.
 *
 * Two properties, and the second is the one that is easy to lose. (1) The
 * body is ONE sender-controlled field, still last and alone: brief, blank
 * line, detail — one message by one author in one frame, not two fields a
 * reader might trust differently. (2) The concatenation happens BEFORE every
 * guard, so rejection, sanitizing, the bidi scan, the byte count and the
 * truncation flag all measure the string the caller actually receives.
 */
describe('the MCP body carries brief and detail as one field', () => {
  it('composes brief + blank line + detail, with body still the LAST key', async () => {
    const log = makeAccount('rounds-body');
    log.append(
      rec({
        tcm: 'grp.msg',
        text: 'the retry storm is ours',
        detail: 'Full finding:\nthe backoff resets on every 429.',
        ref: `${PEER}.${RM}`,
        grp: ROOM,
        rm: RM,
        ai: true,
        men: true,
      }),
    );
    const m = (await read('rounds-body')).messages[0];

    expect(m.body).toBe('the retry storm is ours\n\nFull finding:\nthe backoff resets on every 429.');
    // BODY LAST AND ALONE — the structural injection defence. Asserted on the
    // key ORDER of the object a client receives, because "last" is the part a
    // new field silently ends.
    expect(Object.keys(m).at(-1)).toBe('body');
    // The provenance siblings the sender cannot reach from inside the body.
    expect(m.ai_authored).toBe(true);
    expect(m.mentions_me).toBe(true);
    expect(m.in_reply_to).toBe(`${PEER}.${RM}`);
    // NO ROOM ID. This surface's narrowness about the operator's social graph
    // is a decision, and a detail does not widen it.
    expect(JSON.stringify(m)).not.toContain(ROOM);
    expect(m.grp).toBeUndefined();
    expect(m.rm).toBeUndefined();
    expect(m.detail).toBeUndefined();
  });

  it('leaves a brief-only message byte-identical to what it was', async () => {
    const log = makeAccount('rounds-plain');
    log.append(rec({ text: 'just the brief' }));
    const m = (await read('rounds-plain')).messages[0];
    expect(m.body).toBe('just the brief');
    expect(m.body).not.toContain('\n');
    expect(m.ai_authored).toBeUndefined();
    expect(m.mentions_me).toBeUndefined();
  });

  it('counts and truncates over the COMBINED string, not the brief alone', async () => {
    const log = makeAccount('rounds-bytes');
    const detail = 'd'.repeat(3_000);
    log.append(rec({ text: 'brief', detail }));
    const m = (await read('rounds-bytes')).messages[0];
    expect(m.byte_count).toBe(Buffer.byteLength(`brief\n\n${detail}`, 'utf8'));
    expect(m.byte_count).toBeGreaterThan(Buffer.byteLength('brief', 'utf8'));
    expect(m.truncated).toBeUndefined();
    expect(m.body.endsWith('d')).toBe(true);

    // …and past the body cap the flag is set, which it could not be if the
    // measurement ran over `text` alone: a 5-byte brief is never truncated.
    const big = makeAccount('rounds-bigdetail');
    big.append(rec({ text: 'brief', detail: 'e'.repeat(BODY_CAP_BYTES + 500) }));
    const cut = (await read('rounds-bigdetail')).messages[0];
    expect(cut.truncated).toBe(true);
    expect(Buffer.byteLength(cut.body, 'utf8')).toBeLessThanOrEqual(BODY_CAP_BYTES);
    expect(cut.byte_count).toBeGreaterThan(BODY_CAP_BYTES);
  });

  it('REJECTS a lone surrogate in the detail rather than repairing it', async () => {
    // The guard exists because a lone surrogate survives JSON.parse and
    // re-serializes into bytes no strict decoder accepts. Run over `r.text`
    // alone it would be a guard the detail walks straight past — the brief
    // here is impeccable and the detail is not.
    const log = makeAccount('rounds-surrogate');
    log.append(rec({ text: 'a perfectly clean brief', detail: `a broken pair: \uD83D and the rest` }));
    const m = (await read('rounds-surrogate')).messages[0];
    expect(m.invalid_utf8).toBe(true);
    expect(m.body).toBe('');
    expect(m.byte_count).toBe(0);
    // WITHHELD WHOLE: not the clean brief beside a rejected detail, because
    // half a message is a finding with its evidence removed.
    expect(m.body).not.toContain('perfectly clean');
  });

  it('flags bidi controls that live only in the detail', async () => {
    const log = makeAccount('rounds-bidi');
    log.append(rec({ text: 'plain brief', detail: 'reordered \u202Etxet\u202C here' }));
    const m = (await read('rounds-bidi')).messages[0];
    expect(m.contains_bidi_controls).toBe(true);
  });

  it('strips C0 controls from the detail exactly as it does from the brief', async () => {
    const log = makeAccount('rounds-controls');
    log.append(rec({ text: 'brief', detail: 'before\u001b[2Jafter\nkept' }));
    const m = (await read('rounds-controls')).messages[0];
    expect(m.body).toBe('brief\n\nbefore[2Jafter\nkept');
    expect(m.body).not.toContain('\u001b');
  });

  it('says nothing at all about a redacted row', async () => {
    const log = makeAccount('rounds-redacted');
    // `ts` is NOW here: the shared `rec()` dates rows in 1970, which
    // `applyRetention` DROPS as past the 30-day ceiling before it ever reaches
    // the redaction arm this case is about.
    const r = rec({ ts: Date.now(), text: 'brief', detail: 'the whole finding, with 4211 in it' });
    log.append(r);
    log.markRead([r.id], Date.now() - REDACT_AFTER_MS - 1000);
    expect(log.applyRetention().redacted).toBe(1);
    const m = (await read('rounds-redacted')).messages[0];
    expect(m.redacted).toBe(true);
    expect(m.body).toBe('');
    expect(JSON.stringify(m)).not.toContain('4211');
    // `byte_count` is the stored `bytes` — the brief alone. Inventing a number
    // for erased content would be worse than the documented under-report.
    expect(m.byte_count).toBe(Buffer.byteLength('brief', 'utf8'));
  });
});
