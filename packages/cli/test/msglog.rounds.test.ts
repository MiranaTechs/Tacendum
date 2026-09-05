import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'tacendum-msglog-rounds-'));
process.env.TACENDUM_HOME = home;

const { MessageLog, REDACT_AFTER_MS } = await import('../src/msglog.js');
type MessageRecord = import('../src/msglog.js').MessageRecord;

const PEER = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const ROOM = '01GRPGRPGRPGRPGRPGRPGRPGRP';
const RM = '01MMMMMMMMMMMMMMMMMMMMMMMM';

let seq = 0;
function rec(over: Partial<MessageRecord> = {}): MessageRecord {
  seq += 1;
  return {
    id: `01HXXXXXXXXXXXXXXXXXX${String(seq).padStart(5, '0')}`,
    dir: 'in',
    peer: PEER,
    ts: Date.now(),
    tcm: '',
    text: `text ${seq}`,
    read: false,
    ...over,
  };
}

/**
 * task 3 / R16 — the line the redaction rebuild draws.
 *
 * `applyRetention` rebuilds a consumed row from an ALLOWLIST, and the whole
 * question this file answers is which side of that list a detail is on.
 * `grp`, `men`, `ai` and `rm` are ULID/flag-class routing this client derived
 * from an authenticated frame: dropping one silently changes where messages
 * go, which is why they ride through (the trap that already bit `grp`/`men`/
 * `ai` once). A detail is PROSE A PEER WROTE — the second half of the same
 * message `text` is the first half of — so it is purged with the body it
 * belongs to. Written in the exact shape of the existing "redaction preserves
 * the ROOM routing/exclusion metadata" case, because the two rules are one
 * rule read from opposite ends.
 */
describe('retention purges the detail and keeps the routing', () => {
  it('rm survives, detail is GONE, text is empty and red is true', () => {
    const log = new MessageLog('rounds-redact');
    const r1 = rec({
      // An inbound room answer: the shape a round actually lands in.
      tcm: 'grp.msg',
      text: 'the staging key rotation is the fault',
      detail: 'Full finding: the rotation job leaks the staging key 4211 into the build log.',
      grp: ROOM,
      rm: RM,
      men: true,
      ai: true,
      ref: `${PEER}.${RM}`,
    });
    log.append(r1);
    log.markRead([r1.id], Date.now() - REDACT_AFTER_MS - 1000); // consumed >24h ago

    expect(log.applyRetention().redacted).toBe(1);
    const [kept] = log.read();

    // The BODY is gone — both halves of it, because both halves are body.
    expect(kept?.text).toBe('');
    expect(kept?.red).toBe(true);
    expect(kept?.detail).toBeUndefined();
    // …and it is off the DISK, not merely off the API. `--purge`'s promise is
    // "get the consumed plaintext off this disk NOW", and a surviving detail
    // would make that false by the width of a whole finding.
    const onDisk = readFileSync(log.path, 'utf8');
    expect(onDisk).not.toContain('4211');
    expect(onDisk).not.toContain('Full finding');
    expect(onDisk).not.toContain('detail');

    // The routing rode through, unchanged.
    expect(kept?.grp).toBe(ROOM);
    expect(kept?.rm).toBe(RM);
    expect(kept?.men).toBe(true);
    expect(kept?.ai).toBe(true);
    expect(kept?.ref).toBe(`${PEER}.${RM}`);
  });

  it('reports `bytes` as the DELIVERED body — the brief, not brief plus detail', () => {
    // `bytes` is documented as the size of what was shown and `mcp.ts` reports
    // it as `byte_count`; silently redefining it to "everything the frame
    // carried" would leave a caller comparing it against a body it received
    // with an unexplained discrepancy. Under-reporting is the stated trade.
    const log = new MessageLog('rounds-bytes');
    const r1 = rec({ text: 'brief only', detail: 'x'.repeat(500) });
    log.append(r1);
    log.markRead([r1.id], Date.now() - REDACT_AFTER_MS - 1000);
    expect(log.applyRetention().redacted).toBe(1);
    expect(log.read()[0]?.bytes).toBe(Buffer.byteLength('brief only', 'utf8'));
  });

  it('round-trips a detail through the spool while the row is live', () => {
    // The purge is a purge, not an inability to store: an unread row keeps its
    // detail exactly as written, or `inbox --detail` would have nothing to
    // show and the redaction case above would be passing over an absence.
    const log = new MessageLog('rounds-live');
    const detail = 'line one\nline two\twith a tab';
    const r1 = rec({ tcm: 'reply', text: 'the brief', detail, ref: `${PEER}.${RM}` });
    log.append(r1);
    const [kept] = log.read();
    expect(kept?.text).toBe('the brief');
    expect(kept?.detail).toBe(detail);
    // Unread bodies are not touched even by a forced purge — nobody consumed
    // them — so the detail is still there afterwards.
    expect(log.purge().redacted).toBe(0);
    expect(log.read()[0]?.detail).toBe(detail);
  });
});
