import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Spool metadata for the room trigger predicate.
 *
 * RenderedBody gains `grp` (the room id, env.g) and `men` (the structured
 * mention envelope's who[] names THIS account) — ULID-class metadata under
 * the "store less" posture — a deliberate ruling. The flag is computed
 * where `id === names.selfId` already resolves `@you`; rendered TEXT never
 * decides it (structured mention only — a deliberate rule).
 */

const home = mkdtempSync(join(tmpdir(), 'tacendum-room-meta-'));
process.env.TACENDUM_HOME = home;

const { renderBody, maySpool } = await import('../src/render.js');
const { applyGroupNew, ownerOnlyPolicy } = await import('@tacendum/shared/group-fold');
const { FileGroupStore } = await import('../src/rooms.js');
const { groupBodyRenderer } = await import('../src/room-render.js');
const { MessageLog } = await import('../src/msglog.js');

const ANA = '01CCCCCCCCCCCCCCCCCCCCCCCC';
const BEN = '01DDDDDDDDDDDDDDDDDDDDDDDD';
const ROOM = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const M = '01ARZ3NDEKTSV4RRFFQ69G5FB0';
const MARK = '￼';

const names = { selfId: BEN, nameFor: () => undefined };

function mention(who: string[], text = `hey ${MARK} look`): string {
  return JSON.stringify({ tcm: 'mention', text, who });
}

describe('the mention arm computes mentions-self from who[] (never from text)', () => {
  it('sets men when who[] names this account', () => {
    const r = renderBody(mention([BEN]), undefined, names);
    expect(r.tcm).toBe('mention');
    expect(r.text).toBe('hey @you look');
    expect(r.men).toBe(true);
  });

  it('does not set men when who[] names someone else — even if the TEXT spells this account', () => {
    const r = renderBody(mention([ANA], `${MARK} ping @you ping ${BEN}`), undefined, names);
    expect(r.men).toBeUndefined();
  });

  it('does not set men without an injected resolution — fails closed', () => {
    const r = renderBody(mention([BEN]));
    expect(r.men).toBeUndefined();
  });
});

describe('the room wrapper carries grp and propagates men (the room-wrapped mention path)', () => {
  function seedRoom(client: string): void {
    const store = FileGroupStore.load(client, ROOM);
    applyGroupNew(store, BEN, { writerId: ANA, members: [ANA, BEN], seq: 1 }, ownerOnlyPolicy);
    store.setName('Kitchen');
    store.persist();
  }

  it('a room-wrapped mention of this account renders with grp + men', () => {
    seedRoom('meta-ben');
    const render = groupBodyRenderer('meta-ben', BEN, ANA);
    const r = render(
      'grp.msg',
      JSON.stringify({ tcm: 'grp.msg', g: ROOM, m: M, b: mention([BEN]) }),
    );
    expect(r.tcm).toBe('grp.msg');
    expect(r.grp).toBe(ROOM);
    expect(r.men).toBe(true);
    expect(maySpool(r), 'the row still spools exactly as before').toBe(true);
  });

  it('a room-wrapped mention of someone ELSE carries grp but never men', () => {
    seedRoom('meta-ben2');
    const render = groupBodyRenderer('meta-ben2', BEN, ANA);
    const r = render(
      'grp.msg',
      JSON.stringify({ tcm: 'grp.msg', g: ROOM, m: M, b: mention([ANA]) }),
    );
    expect(r.grp).toBe(ROOM);
    expect(r.men).toBeUndefined();
  });

  it('plain room text carries grp only — and the inner reply\'s compound ref still survives the wrapper', () => {
    seedRoom('meta-ben3');
    const render = groupBodyRenderer('meta-ben3', BEN, ANA);
    const plain = render(
      'grp.msg',
      JSON.stringify({ tcm: 'grp.msg', g: ROOM, m: M, b: 'just words' }),
    );
    expect(plain.grp).toBe(ROOM);
    expect(plain.men).toBeUndefined();
    const reply = render(
      'grp.msg',
      JSON.stringify({
        tcm: 'grp.msg', g: ROOM, m: M,
        b: JSON.stringify({ tcm: 'reply', text: 'continuing', ref: `${BEN}.${M}` }),
      }),
    );
    expect(reply.grp).toBe(ROOM);
    expect(reply.ref).toBe(`${BEN}.${M}`);
  });
});

describe('downgrade tolerance — the spool read is JSON-parse loose', () => {
  it('a new-shaped row (grp + men) reads back whole, and its conversational fields are unchanged', () => {
    const log = new MessageLog('meta-spool');
    log.append({
      id: '01HQXM0000000000000000000A', dir: 'in', peer: ANA, ts: Date.now(),
      tcm: 'grp.msg', text: '[Kitchen] @you hello', read: false,
      grp: ROOM, men: true, ref: `${BEN}.${M}`,
    });
    const rows = log.read();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // What an older build reads off this line is exactly what it read
    // before: the conversational fields, byte-identical — the extra keys
    // ride along in the parsed object and nothing downstream chokes.
    expect(row.text).toBe('[Kitchen] @you hello');
    expect(row.tcm).toBe('grp.msg');
    expect(row.ref).toBe(`${BEN}.${M}`);
    expect(row.grp).toBe(ROOM);
    expect(row.men).toBe(true);
    rmSync(join(home, 'state', 'meta-spool'), { recursive: true, force: true });
  });

  it('an old-shaped row (no grp, no men) still reads — absence, not an error', () => {
    const log = new MessageLog('meta-spool2');
    log.append({
      id: '01HQXM0000000000000000000B', dir: 'in', peer: ANA, ts: Date.now(),
      tcm: 'grp.msg', text: '[Kitchen] old row', read: false,
    });
    const row = log.read()[0]!;
    expect(row.grp).toBeUndefined();
    expect(row.men).toBeUndefined();
    rmSync(join(home, 'state', 'meta-spool2'), { recursive: true, force: true });
  });
});
