import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `attend status` MUST TELL THE TRUTH, AND MUST NOT TOUCH ANYTHING
 *.
 *
 * Two properties, each pinned because the natural implementation gets it
 * wrong silently:
 *
 *  1. THE WINDOW-EXPIRY RULE. `takeTurnToken` treats a bucket whose window
 *     started an hour ago as EMPTY (`now - windowStart >= 3_600_000 → 0
 *     used`). A status that reads the file raw reports the full budget as
 *     spent for a window that closed long ago — "10 of 10 used", forever —
 *     which is exactly the "attend is bricked at its hourly limit" symptom
 *     the operator runs this command to diagnose. The reader must report
 *     what the NEXT pass will find, not what the last one wrote.
 *
 *  2. A READ COMMAND MUST NOT MUTATE. `attendState` takes no lock, marks
 *     nothing read and takes no token — doctor's observe-never-repair rule.
 *     A probe that spent a token or contended for the turn lock would change
 *     the very state it reports; this file holds the byte-identity of every
 *     attend state file across a run of the command, and the absence of any
 *     lock file afterwards.
 *
 * Plus the classification that motivated the command at all: THREE non-
 * enabled states, not two. `loadAttendConfig` collapses a corrupt config
 * into null — the same null the deliberately-written empty file produces —
 * so before this reader existed, a mangled attend.json was indistinguishable
 * from "disabled on purpose" everywhere in the product. The collapse is
 * asserted here too, so if it ever changes, this file names the assumption
 * that moved.
 */

const home = mkdtempSync(join(tmpdir(), 'tacendum-attend-status-truth-'));
process.env.TACENDUM_HOME = home;
process.env.TACENDUM_API = 'http://attend-status.test';
process.env.TACENDUM_WS = 'ws://attend-status.test';

const { attendState, cmdAttendStatus, loadAttendConfig, saveAttendConfig } = await import(
  '../src/attend.js'
);
const { MessageLog } = await import('../src/msglog.js');
const { saveProfile } = await import('../src/profile.js');
const { Reporter } = await import('../src/output.js');

const OWNER = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const OWN_SESSION = 'ffffffff-9999-4999-8999-999999999999';
const HOUR = 60 * 60 * 1000;

const CFG = {
  host: 'claude' as const,
  bin: '/opt/agent',
  workdir: '/w',
  caps: ['--permission-mode', 'plan'],
  ownSession: OWN_SESSION,
  turnsPerHour: 6,
};

const statePath = (file: string): string => join(home, 'state', 'bot', file);

function capture(): { rep: InstanceType<typeof Reporter>; human: string[] } {
  const human: string[] = [];
  const rep = new Reporter({ json: false, plain: true });
  rep.emit = (_record: Record<string, unknown>, h: string) => {
    human.push(h);
  };
  return { rep, human };
}

function freshBot(): void {
  rmSync(join(home, 'bot'), { recursive: true, force: true });
  rmSync(join(home, 'state'), { recursive: true, force: true });
  saveProfile({
    name: 'bot',
    identityKey: 'AAAA',
    userId: '01HQXW0000000000000000TEST',
    deviceId: 1,
    authToken: 'tok',
    registrationId: 1,
    accountClass: 'integration',
    ownerUserId: OWNER,
  });
  saveAttendConfig('bot', CFG);
}

describe('the budget the reader reports is the budget the next pass gets', () => {
  it('an expired window reads as ZERO used — the raw file count is the bricked-attend lie', () => {
    freshBot();
    const now = Date.now();
    mkdirSync(join(home, 'state', 'bot'), { recursive: true, mode: 0o700 });
    // The whole budget spent — in a window that closed an hour ago. A raw
    // read reports 6 of 6 and the operator concludes attend is wedged; the
    // next `takeTurnToken` will find a fresh window and hand out a token.
    writeFileSync(
      statePath('attend-bucket.json'),
      JSON.stringify({ windowStart: now - 2 * HOUR, turns: CFG.turnsPerHour }),
    );
    const expired = attendState('bot', { now: () => now });
    expect(expired.state).toBe('enabled');
    if (expired.state === 'enabled') {
      expect(
        expired.turnsUsed,
        'an expired window must read as a fresh budget — takeTurnToken will reset it',
      ).toBe(0);
    }
    // And a LIVE window keeps its count: the rule is freshness, not amnesia.
    writeFileSync(
      statePath('attend-bucket.json'),
      JSON.stringify({ windowStart: now - 30 * 60_000, turns: 4 }),
    );
    const live = attendState('bot', { now: () => now });
    expect(live.state).toBe('enabled');
    if (live.state === 'enabled') expect(live.turnsUsed).toBe(4);
  });
});

describe('three states, not two', () => {
  it('absent, disabled and unparseable are told apart — loadAttendConfig collapses the last two', () => {
    freshBot();
    const cfgPath = join(home, 'bot', 'attend.json');

    rmSync(cfgPath, { force: true });
    expect(attendState('bot').state).toBe('absent');

    // What `cmdAttendDisable` writes: the deliberate off state.
    writeFileSync(cfgPath, '');
    expect(attendState('bot').state).toBe('disabled');

    // A corrupt config: present, non-empty, does not load. Nobody chose it.
    writeFileSync(cfgPath, '{"host": "claude", "bin": ');
    expect(attendState('bot').state).toBe('unparseable');
    // A host this build has no driver for is unloadable in the same sense.
    writeFileSync(cfgPath, JSON.stringify({ ...CFG, host: 'cursor' }));
    expect(attendState('bot').state).toBe('unparseable');

    // The collapse this distinction exists to see past: to the runtime
    // loader, corrupt and disabled are the same null. If this ever fails,
    // the premise moved and the reader's comment needs to move with it.
    writeFileSync(cfgPath, '{"host": "claude", "bin": ');
    expect(loadAttendConfig('bot')).toBeNull();
    writeFileSync(cfgPath, '');
    expect(loadAttendConfig('bot')).toBeNull();
  });
});

describe('a read command must not mutate', () => {
  it('bucket, cursor and journal are byte-identical across status, and no lock appears', () => {
    freshBot();
    const now = Date.now();
    mkdirSync(join(home, 'state', 'bot'), { recursive: true, mode: 0o700 });
    // One pending row, so the pending-count path (the only one that opens
    // the spool) actually runs rather than short-circuiting on empty.
    new MessageLog('bot').append({
      id: '01HQXW0000000000000000ROW1',
      dir: 'in',
      peer: OWNER,
      ts: now - 30_000,
      tcm: '',
      text: 'a pending message the reader must count and never consume',
      read: false,
    });
    writeFileSync(
      statePath('attend-bucket.json'),
      JSON.stringify({ windowStart: now - 10 * 60_000, turns: 2 }),
    );
    writeFileSync(
      statePath('attend-cursor.json'),
      JSON.stringify({ lastId: '01HQXW0000000000000000ROW0', lastTs: now - 60_000 }),
    );
    writeFileSync(
      statePath('attend-journal.json'),
      JSON.stringify({ upTo: '01HQXW0000000000000000ROW1', startedAt: now - 45_000 }),
    );

    const files = ['attend-bucket.json', 'attend-cursor.json', 'attend-journal.json'];
    const before = files.map(f => readFileSync(statePath(f), 'utf8'));

    // Both dispatch shapes: the named account and the bare sweep.
    cmdAttendStatus('bot', capture().rep);
    cmdAttendStatus(null, capture().rep);

    for (let i = 0; i < files.length; i += 1) {
      expect(
        readFileSync(statePath(files[i] as string), 'utf8'),
        `${files[i]} changed under a status read`,
      ).toBe(before[i] as string);
    }
    // No lock was taken: not the turn lock (the pass serializer) and not the
    // bucket lock (the token counter's) — a reader queues behind nobody.
    expect(existsSync(statePath('attend-turn.lock'))).toBe(false);
    expect(existsSync(statePath('attend-bucket.lock'))).toBe(false);
    // And the spool row is still unread: the cursor files above belong to
    // attend; the read flag belongs to the operator's inbox.
    expect(new MessageLog('bot').read({ dir: 'in' })[0]?.read).toBe(false);
  });
});
