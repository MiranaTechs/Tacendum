import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderBody } from '../src/render.js';
import { MessageLog } from '../src/msglog.js';

/**
 * F2/F3 durability regressions, verified.
 */

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tacendum-f2f3-'));
  process.env.TACENDUM_HOME = home;
});
afterEach(() => {
  delete process.env.TACENDUM_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe('F2: only call.* is transport — everything else is a message', () => {
  it('classifies structured non-call envelopes as messages, not call transport', () => {
    // `onBody` returns TRUE for these (it cannot parse them as calls and
    // reports "unsupported"), so keying the persist branch off it dropped
    // every reply, photo, reaction and vault item that arrived during
    // `listen --calls`. The namespace is the signal that actually answers
    // "is this call transport".
    for (const body of [
      '{"tcm":"reply","ref":"01ARZ3NDEKTSV4RRFFQ69G5FAV","text":"see you at 8"}',
      '{"tcm":"image","att":"a","key":"k","w":100,"h":100}',
      '{"tcm":"react","ref":"01ARZ3NDEKTSV4RRFFQ69G5FAV","ofs":false,"emoji":"👍"}',
      '{"tcm":"somethingfromthefuture","x":1}',
      'plain text',
    ]) {
      const r = renderBody(body);
      expect(r.carrier && r.tcm.startsWith('call.')).toBe(false);
    }
  });

  it('classifies call envelopes as transport, including unknown call.* kinds', () => {
    for (const body of [
      '{"tcm":"call.offer","cid":"01ARZ3NDEKTSV4RRFFQ69G5FAV","sdp":"x"}',
      '{"tcm":"call.future","cid":"01ARZ3NDEKTSV4RRFFQ69G5FAV"}',
    ]) {
      const r = renderBody(body);
      expect(r.carrier && r.tcm.startsWith('call.')).toBe(true);
    }
  });
});

describe('F3: a failed append must not corrupt the next one', () => {
  it('leaves only whole records in the spool', () => {
    const log = new MessageLog('bot');
    log.append({ id: '01A', dir: 'in', peer: 'p', ts: 1, tcm: '', text: 'one', read: false });
    log.append({ id: '01B', dir: 'in', peer: 'p', ts: 2, tcm: '', text: 'two', read: false });

    const raw = readFileSync(log.path, 'utf8');
    const lines = raw.split('\n').filter((l) => l !== '');
    expect(lines).toHaveLength(2);
    // Every line parses — the invariant a partial write used to break by
    // gluing the next record onto an unterminated prefix.
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    expect(raw.endsWith('\n')).toBe(true);
  });
});
