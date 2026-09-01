import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monotonicFactory } from 'ulid';
import type { ClientFrame, PrekeyBundle, ServerFrame } from '@tacendum/shared';

const home = mkdtempSync(join(tmpdir(), 'tacendum-room-inbound-'));
process.env.TACENDUM_HOME = home;

const { FileStores } = await import('../src/stores.js');
const { generateAndStoreKeys, establishSession, encryptText } = await import(
  '../src/messaging.js'
);
const { attachInbound } = await import('../src/inbound.js');
const { MessageLog } = await import('../src/msglog.js');
const { FileGroupStore } = await import('../src/rooms.js');
const { foldRoster, ownerOnlyPolicy, verdictFor } = await import(
  '@tacendum/shared/group-fold'
);
type WsClient = import('../src/wsclient.js').WsClient;
type Reporter = import('../src/output.js').Reporter;

// Crockford-valid ULIDs: room lanes and room files are keyed on these, so an
// illegal letter would be exercising the id guard instead of the rule.
const ANA = '01CCCCCCCCCCCCCCCCCCCCCCCC';
const BEN = '01DDDDDDDDDDDDDDDDDDDDDDDD';
const DAVE = '01FFFFFFFFFFFFFFFFFFFFFFFF';
const ROOM = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const MSG1 = '01ARZ3NDEKTSV4RRFFQ69G5FB0';
const MSG2 = '01ARZ3NDEKTSV4RRFFQ69G5FB1';
const ulid = monotonicFactory();

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
  acked(msgId: string): boolean {
    return this.sent.some(f => f.type === 'ack' && f.msgId === msgId);
  }
}

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

// One real ratchet pair for the whole file, exactly as inbound.test.ts sets
// up: the properties under test are about routing, suppression and applied
// room state — the crypto is real so the path under test is the shipped one.
const anaStores = new FileStores('rin-ana');
const benStores = new FileStores('rin-ben');
await generateAndStoreKeys(anaStores);
const benUpload = await generateAndStoreKeys(benStores);
await establishSession(anaStores, ANA, bundleFrom(BEN, benUpload));

const log = new MessageLog('rin-ben');

async function deliver(body: string) {
  const { msgType, payload } = await encryptText(anaStores, ANA, BEN, body);
  const msgId = ulid();
  const ws = new FakeWs();
  const { r, lines, notes } = fakeReporter();
  const inbound = attachInbound({
    name: 'rin-ben',
    userId: BEN,
    stores: benStores,
    ws: ws as unknown as WsClient,
    report: r,
    log,
    consume: true,
  });
  ws.deliver({ type: 'msg', from: ANA, msgId, msgType, payload, ts: 4242 });
  await inbound.settled();
  return { msgId, ws, lines, notes };
}

const blockedPath = join(home, 'state', 'rin-ben', 'blocked.json');

/**
 * the design plan over the FULL inbound path: real ciphertext, the
 * real decrypt, the real spool, the real room files. What the unit suite
 * proves about sentences, this suite proves about the wire: routing order,
 * suppression, and the room state a frame leaves behind.
 */
describe('room frames through the real inbound path', () => {
  it('anchors a room and renders its traffic attributed to the AUTHENTICATED sender', async () => {
    const created = await deliver(
      JSON.stringify({ tcm: 'grp.new', g: ROOM, nm: 'Kitchen', ms: [ANA, BEN], n: 1 }),
    );
    expect(created.ws.acked(created.msgId)).toBe(true);
    expect(
      created.lines.some(l => l.text === `[Kitchen] [started this room — ${ROOM}]`),
    ).toBe(true);

    const msg = await deliver(
      JSON.stringify({ tcm: 'grp.msg', g: ROOM, m: MSG1, b: 'hello room over the real wire' }),
    );
    const line = msg.lines.find(l => l.text === '[Kitchen] hello room over the real wire');
    expect(line).toBeDefined();
    // frame.from, which the ratchet vouched for — never a payload field.
    expect(line!.from).toBe(ANA);
    // Room TEXT is conversational and reaches the durable spool, rendered.
    const spooled = log.read().find(rec => rec.id === msg.msgId);
    expect(spooled).toMatchObject({
      peer: ANA,
      tcm: 'grp.msg',
      text: '[Kitchen] hello room over the real wire',
    });
  });

  it('an x.-prefixed body prints NOTHING AT ALL — no stdout, no stderr — and is still consumed', async () => {
    const before = log.read().length;
    const { msgId, ws, lines, notes } = await deliver('{"tcm":"x.ack","n":1}');
    // Consumed like any frame: acked, so it never redelivers…
    expect(ws.acked(msgId)).toBe(true);
    // …and invisible on every surface: no line, no note, no spool row.
    expect(lines).toEqual([]);
    expect(notes).toEqual([]);
    expect(log.read().length).toBe(before);
  });

  it('never prints a raw envelope, whatever shape a room body arrives in', async () => {
    const bodies = [
      `{"tcm":"grp.future","g":"${ROOM}","payload":"SHAPE-FROM-THE-FUTURE"}`,
      '{"tcm":"grp.msg","g":"not-a-ulid"}',
    ];
    for (const body of bodies) {
      const { lines, notes } = await deliver(body);
      const shown = [...lines.map(l => String(l.text)), ...notes].join('\n');
      expect(shown).not.toContain('{"tcm"');
      expect(shown).not.toContain('SHAPE-FROM-THE-FUTURE');
      // Visible, though: a kind this build cannot read is a notice, never
      // silence — dropping it would hide that anything arrived.
      expect(lines.length).toBeGreaterThan(0);
    }
  });

  it('a blocked sender is suppressed whole — 1:1 and room alike — while room STATE still applies', async () => {
    mkdirSync(join(home, 'state', 'rin-ben'), { recursive: true });
    writeFileSync(blockedPath, JSON.stringify([ANA]));
    try {
      // 1:1: decrypted, ACKED byte-identically (the block must be invisible
      // to the blocked party), and then NOTHING — no line, no note, no spool.
      const spoolBefore = log.read().length;
      const direct = await deliver('secret ping from a blocked sender');
      expect(direct.ws.acked(direct.msgId)).toBe(true);
      expect(direct.lines).toEqual([]);
      expect(direct.notes).toEqual([]);
      expect(log.read().length).toBe(spoolBefore);
      expect(readFileSync(log.path, 'utf8')).not.toContain('secret ping');

      // Room traffic: same gate, same key (frame.from), same silence.
      const room = await deliver(
        JSON.stringify({ tcm: 'grp.msg', g: ROOM, m: MSG2, b: 'room words from blocked' }),
      );
      expect(room.ws.acked(room.msgId)).toBe(true);
      expect(room.lines).toEqual([]);
      expect(log.read().length).toBe(spoolBefore);

      // THE FOLD IS NOT FORKED BY A LOCAL BLOCK LIST: the blocked owner's
      // roster write still counts, or this client diverges from every other
      // member and the block becomes visible through the rd digest.
      const add = await deliver(
        JSON.stringify({ tcm: 'grp.roster', g: ROOM, m: DAVE, s: 'in', n: 2 }),
      );
      expect(add.lines).toEqual([]); // announced to nobody: the writer is blocked
      const store = FileGroupStore.load('rin-ben', ROOM);
      const fold = foldRoster(store.getOwner()!, store.listSlots(), ownerOnlyPolicy);
      expect(verdictFor(fold, DAVE)).toBe('in');
    } finally {
      rmSync(blockedPath, { force: true });
    }

    // The gate reads the file live: unblocking needs no restart.
    const after = await deliver('audible again');
    expect(after.lines.some(l => l.text === 'audible again')).toBe(true);
  });
});

/**
 * Over the real inbound path: the spool metadata the room trigger
 * predicate reads — `grp` + `men` — is persisted on grp.msg rows ONLY, and
 * the `men` flag comes from the structured who[] (a deliberate rule), never
 * from the rendered text.
 */
describe('room trigger metadata reaches the spool', () => {
  const MARK = '￼';

  it('a room-wrapped mention of THIS account persists grp + men', async () => {
    const body = JSON.stringify({
      tcm: 'grp.msg', g: ROOM, m: ulid(),
      b: JSON.stringify({ tcm: 'mention', text: `${MARK} build it`, who: [BEN] }),
    });
    const { msgId } = await deliver(body);
    const row = log.read().find(rec => rec.id === msgId);
    expect(row).toBeDefined();
    expect(row!.grp).toBe(ROOM);
    expect(row!.men).toBe(true);
    expect(row!.text).toBe('[Kitchen] @you build it');
  });

  it('a room-wrapped mention of someone ELSE persists grp but never men — text spelling the name changes nothing', async () => {
    const body = JSON.stringify({
      tcm: 'grp.msg', g: ROOM, m: ulid(),
      b: JSON.stringify({ tcm: 'mention', text: `${MARK} tell @you about ${BEN}`, who: [DAVE] }),
    });
    const { msgId } = await deliver(body);
    const row = log.read().find(rec => rec.id === msgId);
    expect(row).toBeDefined();
    expect(row!.grp).toBe(ROOM);
    expect(row!.men).toBeUndefined();
  });

  it('plain room text persists grp only', async () => {
    const { msgId } = await deliver(
      JSON.stringify({ tcm: 'grp.msg', g: ROOM, m: ulid(), b: 'plain room words' }),
    );
    const row = log.read().find(rec => rec.id === msgId);
    expect(row!.grp).toBe(ROOM);
    expect(row!.men).toBeUndefined();
  });

  it('a BARE 1:1 mention persists NEITHER — grp.msg rows only (the ruling\'s "only")', async () => {
    const { msgId } = await deliver(
      JSON.stringify({ tcm: 'mention', text: `${MARK} direct ping`, who: [BEN] }),
    );
    const row = log.read().find(rec => rec.id === msgId);
    expect(row).toBeDefined();
    expect(row!.text).toBe('@you direct ping');
    expect(row!.grp).toBeUndefined();
    expect(row!.men).toBeUndefined();
  });

  it('a room reply\'s compound ref AND grp both survive to the spool — the reply-to-continue join', async () => {
    const target = `${BEN}.${MSG1}`;
    const { msgId } = await deliver(
      JSON.stringify({
        tcm: 'grp.msg', g: ROOM, m: ulid(),
        b: JSON.stringify({ tcm: 'reply', text: 'and then?', ref: target }),
      }),
    );
    const row = log.read().find(rec => rec.id === msgId);
    expect(row!.grp).toBe(ROOM);
    expect(row!.ref).toBe(target);
    expect(row!.men).toBeUndefined();
  });
});
