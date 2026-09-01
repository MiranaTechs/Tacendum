/**
 * An earlier review — THE RETENTION SEAM. Two predicates decide the fate of a
 * quarantined row, and until this round they disagreed about any `ts` that
 * could not be trusted:
 *
 *  - `rewriteUndelivered` (inbound.ts) DROPPED a malformed-ts row the moment
 *    any quarantine write or attach-time prune ran — at any age, destroying
 *    what may be the last copy of a message whose spool write failed — while
 *    its comment claimed the row "ages out like an expired one".
 *  - `applyRetention` (msglog.ts) KEEPS the same row FOREVER, because
 *    `now - ts >= RETAIN_MS` is false when the subtraction yields NaN — and
 *    keeps a FUTURE-dated row forever on both sides, reachable from the wire
 *    because MsgFrame.ts is an unbounded, server-controlled z.number().
 *
 * The fix, and what each test discriminates:
 *  1. an untrusted ts (missing/non-numeric/future) RESTARTS the clock: the
 *     row is rewritten with ts = now. Revert: restore the drop, test 1 fails.
 *  2. the restarted clock is real — the row ages out RETAIN_MS later.
 *     Revert: keep such rows unconditionally, test 2 fails.
 *  3. the restart happens ONCE (idempotent) — otherwise the row never ages.
 *     Revert: clamp without persisting (skip the write when only a clock was
 *     restarted), test 3 fails.
 *  4. a future-dated row already on disk is not immortal. Revert: restore
 *     `typeof ts === 'number' && now - ts < RETAIN_MS`, test 4 fails.
 *  5. an unparseable line is dropped at the next rewrite AT ANY AGE — the
 *     corrected prose, pinned so it cannot rot back to "ages out".
 *  6. the inbound path caps the ts it PERSISTS at the local clock, so a
 *     future-dated frame cannot seed an immortal row in the spool either.
 *     Revert: `ts: frame.ts` in the append, test 6 fails.
 *  7. the quarantine write is DURABLE — data fsync before the rename, dir
 *     fsync after — because surviving the crash that broke the spool is the
 *     file's one purpose. Proven unguarded before this test existed, and the
 *     measurement (2026-07-30) is stated precisely because its first draft
 *     overclaimed: flipping `writeFileAtomic`'s shared DEFAULT to
 *     'crash-consistent' does NOT go green — gate.stores-durability (x2) and
 *     gate.prekey-durability (x1) fail, so the default is guarded. What went
 *     green — 364/364 pre-existing CLI tests — was switching the QUARANTINE
 *     CALL alone to 'crash-consistent': no data fsync, no directory fsync,
 *     nothing noticed. The one write whose entire reason to exist is
 *     surviving a crash was the one write no test held to that. Revert: pass
 *     'crash-consistent' at rewriteUndelivered's writeFileAtomic call (or
 *     flip the default), test 7 fails on the missing fsync either way.
 */
import { describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { monotonicFactory } from 'ulid';
import type { ClientFrame, PrekeyBundle, ServerFrame } from '@tacendum/shared';

/** fs event recorder for test 7 — passthrough wrappers, behavior unchanged. */
const { fsEvents, fdPaths, realFs } = vi.hoisted(() => ({
  fsEvents: [] as Array<{ op: 'fsync' | 'rename'; path: string; to?: string }>,
  fdPaths: new Map<number, string>(),
  realFs: {} as typeof import('node:fs'),
}));

vi.mock('node:fs', async (importActual) => {
  const actual = await importActual<typeof import('node:fs')>();
  Object.assign(realFs, actual);
  return {
    ...actual,
    default: actual,
    openSync: ((path: unknown, ...rest: unknown[]) => {
      const fd = (actual.openSync as (...a: unknown[]) => number)(path, ...rest);
      fdPaths.set(fd, String(path));
      return fd;
    }) as typeof actual.openSync,
    closeSync: ((fd: number) => {
      fdPaths.delete(fd);
      return actual.closeSync(fd);
    }) as typeof actual.closeSync,
    fsyncSync: ((fd: number) => {
      fsEvents.push({ op: 'fsync', path: fdPaths.get(fd) ?? `fd:${fd}` });
      return actual.fsyncSync(fd);
    }) as typeof actual.fsyncSync,
    renameSync: ((from: unknown, to: unknown) => {
      fsEvents.push({ op: 'rename', path: String(from), to: String(to) });
      return actual.renameSync(from as string, to as string);
    }) as typeof actual.renameSync,
  };
});

// Set BEFORE the src imports: config.ts snapshots the env at module evaluation.
const home = mkdtempSync(join(tmpdir(), 'tacendum-retseam-'));
process.env.TACENDUM_HOME = home;

const { FileStores } = await import('../src/stores.js');
const { generateAndStoreKeys, establishSession, encryptText } = await import('../src/messaging.js');
const { attachInbound, quarantineUndelivered, pruneUndelivered, undeliveredPath } = await import(
  '../src/inbound.js'
);
const { MessageLog, RETAIN_MS } = await import('../src/msglog.js');
type WsClient = import('../src/wsclient.js').WsClient;
type Reporter = import('../src/output.js').Reporter;
type MessageRecord = import('../src/msglog.js').MessageRecord;

const ulid = monotonicFactory();
const NOW = Date.now();

function record(text: string, ts: number): MessageRecord {
  return { id: ulid(), dir: 'in', peer: 'peer', ts, tcm: '', text, read: false };
}

/** A parseable row whose ts is whatever the test says — the operator's hand. */
function rawRow(id: string, ts: unknown, text: string): string {
  return `${JSON.stringify({ id, dir: 'in', peer: 'peer', ts, tcm: '', text, read: false })}\n`;
}

function rows(name: string): Array<{ id: string; ts: unknown }> {
  return readFileSync(undeliveredPath(name), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as { id: string; ts: unknown });
}

describe('the quarantine rewrite (rewriteUndelivered)', () => {
  it('1. RESTARTS the clock on a malformed-ts row instead of destroying it', () => {
    const name = 'seam-restart';
    quarantineUndelivered(name, record('seed', NOW), NOW);
    appendFileSync(undeliveredPath(name), rawRow('MANGLED', 'not-a-number', 'hand repair'), {
      mode: 0o600,
    });

    // The next attach-time prune used to be the destroyer. Now it must keep
    // the row and date it: ts becomes the prune's own `now`, a finite number.
    pruneUndelivered(name, NOW);
    const mangled = rows(name).find(r => r.id === 'MANGLED');
    expect(mangled).toBeDefined();
    expect(mangled?.ts).toBe(NOW);
  });

  it('2. the restarted clock is a real clock: the row ages out RETAIN_MS later', () => {
    const name = 'seam-ages';
    quarantineUndelivered(name, record('seed', NOW), NOW);
    appendFileSync(undeliveredPath(name), rawRow('MANGLED', null, 'dated at observation'), {
      mode: 0o600,
    });
    pruneUndelivered(name, NOW); // first observation: clock starts here
    pruneUndelivered(name, NOW + RETAIN_MS - 1000);
    expect(rows(name).some(r => r.id === 'MANGLED')).toBe(true); // inside the window
    pruneUndelivered(name, NOW + RETAIN_MS + 1000);
    expect(rows(name).some(r => r.id === 'MANGLED')).toBe(false); // and out
  });

  it('3. restarts ONCE: a later prune does not move the observation date', () => {
    const name = 'seam-idem';
    quarantineUndelivered(name, record('seed', NOW), NOW);
    appendFileSync(undeliveredPath(name), rawRow('MANGLED', 'oops', 'observed once'), {
      mode: 0o600,
    });
    pruneUndelivered(name, NOW);
    pruneUndelivered(name, NOW + 5000); // must NOT rewrite ts to NOW + 5000
    expect(rows(name).find(r => r.id === 'MANGLED')?.ts).toBe(NOW);
  });

  it('4. a future-dated row on disk is not immortal', () => {
    const name = 'seam-future';
    quarantineUndelivered(name, record('seed', NOW), NOW);
    appendFileSync(
      undeliveredPath(name),
      rawRow('FUTURE', NOW + 1000 * RETAIN_MS, 'server-dated into 2100'),
      { mode: 0o600 },
    );
    // Kept — it may be the last copy — but re-dated to the local clock…
    pruneUndelivered(name, NOW);
    expect(rows(name).find(r => r.id === 'FUTURE')?.ts).toBe(NOW);
    // …so one retention window later it is gone, not immortal (the old
    // predicate `now - ts < RETAIN_MS` kept it past NOW + 999 * RETAIN_MS).
    pruneUndelivered(name, NOW + RETAIN_MS + 1000);
    expect(rows(name).some(r => r.id === 'FUTURE')).toBe(false);
  });

  it('5. an unparseable line is dropped at the next rewrite, at any age', () => {
    const name = 'seam-torn';
    quarantineUndelivered(name, record('seed', NOW), NOW);
    appendFileSync(undeliveredPath(name), '{"id":"TORN","dir":"in","pe\n', { mode: 0o600 });
    pruneUndelivered(name, NOW); // zero time has passed — dropped anyway
    expect(readFileSync(undeliveredPath(name), 'utf8')).not.toContain('TORN');
  });

  it('7. the quarantine write is durable: data fsync before the rename, dir fsync after', () => {
    const name = 'seam-durable';
    const target = undeliveredPath(name);
    fsEvents.length = 0;
    expect(quarantineUndelivered(name, record('must survive a crash', NOW), NOW)).toBe(target);

    const renameIdx = fsEvents.findIndex(
      e =>
        e.op === 'rename' &&
        e.to === target &&
        /undelivered\.jsonl\.[0-9a-f]{12}\.tmp$/.test(e.path),
    );
    expect(renameIdx).toBeGreaterThan(-1);
    // The temp's DATA was fsynced before it was renamed into place…
    const dataFsync = fsEvents.findIndex(
      e => e.op === 'fsync' && /undelivered\.jsonl\.[0-9a-f]{12}\.tmp$/.test(e.path),
    );
    expect(dataFsync).toBeGreaterThan(-1);
    expect(dataFsync).toBeLessThan(renameIdx);
    // …and the DIRECTORY entry after, or power loss undoes the rename.
    const dirFsync = fsEvents
      .slice(renameIdx + 1)
      .some(e => e.op === 'fsync' && e.path === dirname(target));
    expect(dirFsync).toBe(true);
  });
});

describe('the inbound path caps what it persists at the local clock', () => {
  it('6. a future-dated frame cannot seed an immortal spool row', async () => {
    const ALICE = '01ALICEALICEALICEALICEALIC';
    const BOB = '01BOBBOBBOBBOBBOBBOBBOBBOB';
    const aliceStores = new FileStores('seam-alice');
    const bobStores = new FileStores('seam-bob');
    await generateAndStoreKeys(aliceStores);
    const bobUpload = await generateAndStoreKeys(bobStores);
    const bundle: PrekeyBundle = {
      userId: BOB,
      registrationId: bobUpload.registrationId,
      identityKey: bobUpload.identityKey,
      signedPrekey: bobUpload.signedPrekey,
      kyberPrekey: bobUpload.kyberPrekey,
      oneTimePrekey: bobUpload.oneTimePrekeys[0],
    };
    await establishSession(aliceStores, ALICE, bundle);

    const sent: ClientFrame[] = [];
    const handlers: Array<(f: ServerFrame) => void> = [];
    const ws = {
      onFrame: (h: (f: ServerFrame) => void) => handlers.push(h),
      send: (f: ClientFrame) => sent.push(f),
    } as unknown as WsClient;
    const report = {
      json: true,
      plain: true,
      line: () => {},
      emit: () => {},
      note: () => {},
      status: () => {},
      done: () => {},
    } as unknown as Reporter;

    const log = new MessageLog('seam-bob');
    const inbound = attachInbound({
      name: 'seam-bob',
      userId: BOB,
      stores: bobStores,
      ws,
      report,
      log,
      consume: true,
    });
    const { msgType, payload } = await encryptText(aliceStores, ALICE, BOB, 'dated into 2100');
    const msgId = ulid();
    const before = Date.now();
    for (const h of handlers) {
      h({ type: 'msg', from: ALICE, msgId, msgType, payload, ts: before + 1000 * RETAIN_MS });
    }
    await inbound.settled();

    const [rec] = log.read({ limit: 1 });
    expect(rec?.id).toBe(msgId);
    // Persisted time is the local clock's ceiling, not the server's claim…
    expect(rec?.ts).toBeGreaterThanOrEqual(before);
    expect(rec?.ts).toBeLessThanOrEqual(Date.now());
    // …so the spool's own retention can actually expire it (with frame.ts
    // stored, `now - ts >= RETAIN_MS` stays false until the claimed date and
    // this row was immortal — verified by execution before the fix).
    expect(log.applyRetention({ now: Date.now() + RETAIN_MS + 60_000 }).dropped).toBe(1);
    expect(log.read({ limit: 1 })).toHaveLength(0);
  });
});

describe('the spool refuses a record it could never retire', () => {
  // An earlier revision. An earlier fix capped `attachInbound` and set out to make "a
  // future-dated frame cannot seed an immortal row" true. It capped `listen`
  // and not `listen --calls`, which writes the SAME spool — the mirror
  // divergence this codebase produces more than any other defect. Measured on
  // the uncapped mirror: a frame dated now + 1000*RETAIN_MS persisted as the
  // year 2108 and survived an applyRetention run past its nominal expiry.
  //
  // The cap now lives in `append`, so these cases are about the SPOOL's
  // invariant — every record it holds can be retired — rather than about
  // either caller. That is why they call append directly: a test that went
  // through one caller would pass while the other still diverged, which is
  // exactly how this got here.
  const cases: [label: string, ts: () => number][] = [
    ['far future', () => Date.now() + 1000 * RETAIN_MS],
    // Not 'now + 1ms': the assertions run after real work, so by then the
    // clock has passed it and the case is satisfied whether or not anything
    // capped it — it passed against the uncapped mirror (measured). Five
    // minutes is past any plausible test duration and still an ordinary clock
    // skew rather than an absurd one.
    ['five minutes future', () => Date.now() + 5 * 60_000],
    ['NaN', () => Number.NaN],
    ['Infinity', () => Number.POSITIVE_INFINITY],
  ];

  for (const [label, mkTs] of cases) {
    it(`retires a record whose ts is ${label}`, () => {
      const name = `spoolcap-${label.replace(/[^a-z]/gi, '')}`;
      const log = new MessageLog(name);
      const id = ulid();
      log.append({
        id,
        dir: 'in',
        peer: `01${'PEERPEER'.repeat(3)}`,
        ts: mkTs(),
        tcm: 'txt',
        text: `body-${label}`,
        read: false,
      } as never);

      // It is on disk and readable now — the cap must not have dropped it.
      expect(log.read().map(r => r.id), 'the record was lost, not clamped').toContain(id);

      // THE PERSISTED VALUE, not just the eventual outcome. Asserting only
      // "it expires" was hollow for two of these four: JSON.stringify turns
      // NaN and Infinity into `null`, and `now - null` is `now`, which clears
      // RETAIN_MS — so those rows expired with no cap at all and the cases
      // passed against the bug. What the cap actually guarantees is that the
      // spool never holds a ts it cannot reason about, and that is only
      // visible on disk.
      const stored = log.read().find(r => r.id === id);
      expect(stored, 'record vanished from the spool').toBeDefined();
      expect(
        Number.isFinite((stored as { ts: number }).ts),
        `a ${label} ts reached the spool as a non-number — retention cannot judge it`,
      ).toBe(true);
      expect(
        (stored as { ts: number }).ts,
        `a ${label} ts was persisted ahead of this clock`,
      ).toBeLessThanOrEqual(Date.now());

      // And it dies on schedule. Without the cap this returns dropped:0 and
      // the plaintext body outlives the 30-day ceiling forever.
      const outcome = log.applyRetention({ now: Date.now() + RETAIN_MS + 60_000, force: false });
      expect(
        outcome.dropped,
        `a ${label} ts survived its own retention window — the body is immortal`,
      ).toBeGreaterThan(0);
      expect(log.read().map(r => r.id)).not.toContain(id);
    });
  }
});

describe('the quarantine refuses a record it could never retire', () => {
  // The mirror of the earlier spool fix, and the same divergence one layer
  // down. The same earlier fix capped the `ts` that `attachInbound` quarantines; CallSession
  // quarantines through this SAME function and handed the raw server value, so
  // identical bytes and an identical spool failure produced a row dated ~now on
  // `listen` and the year 2108 on `listen --calls`. Measured by the earlier
  // audit on both paths.
  //
  // These drive `quarantineUndelivered` DIRECTLY, for the reason the spool-cap
  // cases do: a test that went through one caller would pass while the other
  // still diverged, which is exactly how this got here.
  for (const [label, ts] of [
    ['far future', NOW + 1000 * RETAIN_MS],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ] as const) {
    it(`clamps a ${label} ts a caller hands it`, () => {
      const name = `qcap-${label.replace(/[^a-z]/gi, '')}`;
      quarantineUndelivered(name, record(`body-${label}`, ts), NOW);

      const only = rows(name)[0];
      expect(only, 'the row was refused rather than clamped').toBeDefined();
      expect(
        Number.isFinite(only?.ts),
        `a ${label} ts reached the quarantine as a value retention cannot judge`,
      ).toBe(true);
      expect(
        only?.ts as number,
        `a ${label} ts was persisted ahead of the clock — the plaintext outlives the ceiling`,
      ).toBeLessThanOrEqual(NOW);
    });
  }
});

