/**
 * The log-leak sweep — what an inbound OPERATOR NOTE may carry.
 *
 * The flagged surface: the local-failure note printed `err.message`, and for
 * the store shape `err` is libsignal's wrapper, whose text embeds the failing
 * FILE PATH — `ENOSPC … open '/…/<account>/sessions/….bin.tmp'`. Every path
 * under the state directory embeds the ACCOUNT NAME, a caller-supplied value
 * (`--name "$VAR"` is one bad env var from a secret), and the note reaches
 * operator logs, hook logs and CI logs. The same class rode two more sites:
 * the spool-failure note's `(${err.message})` and the render-failure note.
 *
 * The rule under test lives in ONE place — `describeLocalFailure` /
 * `localErrno` (inbound.ts), consumed by both mirrored handlers — and allows
 * exactly: a shape-checked errno, repo-authored prose, and the message of a
 * CliError that crossed the STORE boundary (certified value-free by
 * construction in keychain.ts / stores.ts). A DIRECT CliError (the ratchet
 * lock) is NOT certified — lock.ts deliberately embeds the lock path as a
 * remedy — so its message may not travel here.
 *
 * Sabotage handles (each verified for this round):
 *  - local-failure note back to `err.message` -> tests 1–3 see the path,
 *    the account name, or the lock path;
 *  - spool note back to `err.message` -> test 4 sees the planted path;
 *  - render note back to `renderErr.message` -> test 5 sees the planted text;
 *  - DECRYPT FAILED back to raw `err.name/err.message` -> test 6 sees
 *    control bytes and an unbounded message.
 */
import { describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monotonicFactory } from 'ulid';
import type { ClientFrame, PrekeyBundle, ServerFrame } from '@tacendum/shared';

// The undecryptable-branch injection: a marker payload makes the decrypt
// throw an error whose name and message carry control bytes and an oversize
// tail — the shape nothing certifies libsignal never produces. Everything
// else passes through untouched, so the rest of this file runs real crypto.
vi.mock('../src/messaging.js', async importOriginal => {
  const mod = await importOriginal<typeof import('../src/messaging.js')>();
  return {
    ...mod,
    decryptEnvelope: async (
      ...args: Parameters<typeof mod.decryptEnvelope>
    ): Promise<string> => {
      if (args[4] === 'EVIL-INJECT') {
        const e = new Error(`bad bytes \u001b[31mforged\u0007 line${'X'.repeat(300)}`);
        e.name = 'Evil\u007f\u009bName';
        throw e;
      }
      return mod.decryptEnvelope(...args);
    },
  };
});

const home = mkdtempSync(join(tmpdir(), 'tacendum-logleak-'));
process.env.TACENDUM_HOME = home;

const { FileStores } = await import('../src/stores.js');
const { generateAndStoreKeys, establishSession, encryptText } = await import(
  '../src/messaging.js'
);
const { attachInbound, describeLocalFailure, localErrno } = await import('../src/inbound.js');
const { MessageLog } = await import('../src/msglog.js');
const { CliError, EXIT } = await import('../src/exit.js');
const { clientDir } = await import('../src/config.js');
type WsClient = import('../src/wsclient.js').WsClient;
type Reporter = import('../src/output.js').Reporter;

const ulid = monotonicFactory();
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
  otkIndex = 0,
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

function fakeReporter(lineThrows?: () => Error): {
  r: Reporter;
  lines: Record<string, unknown>[];
  notes: string[];
} {
  const lines: Record<string, unknown>[] = [];
  const notes: string[] = [];
  const r = {
    json: true,
    plain: true,
    line: (record: Record<string, unknown>) => {
      if (lineThrows) throw lineThrows();
      lines.push(record);
    },
    emit: (record: Record<string, unknown>) => lines.push(record),
    note: (text: string) => notes.push(text),
    status: () => {},
    done: () => {},
  } as unknown as Reporter;
  return { r, lines, notes };
}

const SENDER_ID = '01LOGLEAKSENDERSENDERSENDE';
const senderStores = new FileStores('logleak-sender');
await generateAndStoreKeys(senderStores);

async function receiver(name: string, receiverId: string) {
  const stores = new FileStores(name);
  const upload = await generateAndStoreKeys(stores);
  await establishSession(senderStores, SENDER_ID, bundleFrom(receiverId, upload));
  return { stores, log: new MessageLog(name) };
}

async function deliverTo(
  name: string,
  receiverId: string,
  stores: InstanceType<typeof FileStores>,
  log: InstanceType<typeof MessageLog>,
  frame: { msgId: string; msgType: 'prekey' | 'ciphertext'; payload: string },
  lineThrows?: () => Error,
) {
  const ws = new FakeWs();
  const { r, lines, notes } = fakeReporter(lineThrows);
  const inbound = attachInbound({
    name,
    userId: receiverId,
    stores,
    ws: ws as unknown as WsClient,
    report: r,
    log,
    consume: true,
  });
  ws.deliver({
    type: 'msg',
    from: SENDER_ID,
    msgId: frame.msgId,
    msgType: frame.msgType,
    payload: frame.payload,
    ts: Date.now(),
  });
  await inbound.settled();
  return { ws, lines, notes };
}

describe('the local-failure note: errno and certified prose, never a path or the account name', () => {
  it('a session-save EACCES prints the errno; the path and account name never appear', async () => {
    const BOB = '01LOGLEAKEACCESEACCESEACCE';
    const name = 'logleak-eacces';
    const { stores, log } = await receiver(name, BOB);
    const { msgType, payload } = await encryptText(senderStores, SENDER_ID, BOB, 'mail vs full disk');
    expect(msgType).toBe('prekey');

    // The gate-flagged shape: the session save fails with a real fs error.
    // Its message embeds the .bin.tmp path, and the path embeds `name`.
    const sessionsDir = join(clientDir(name), 'sessions');
    chmodSync(sessionsDir, 0o500);
    const msgId = ulid();
    let attempt: Awaited<ReturnType<typeof deliverTo>>;
    try {
      attempt = await deliverTo(name, BOB, stores, log, { msgId, msgType, payload });
    } finally {
      chmodSync(sessionsDir, 0o700);
    }

    // Classification unchanged: local, queued, loud.
    expect(attempt.ws.acked(msgId)).toBe(false);
    expect(stores.hasSeen(msgId)).toBe(false);
    const joined = attempt.notes.join('\n');
    expect(joined).toContain('left on the server, will retry');
    // WHAT failed travels as the errno…
    expect(joined).toContain('(EACCES)');
    // …and nothing that embeds the caller-supplied account name does.
    expect(joined).not.toContain(name);
    expect(joined).not.toContain(clientDir(name));
  });

  it('a store-boundary CliError (unreadable credential) still travels as its certified fixed prose', async () => {
    const CARA = '01LOGLEAKCLIERRCLIERRCLIER';
    const name = 'logleak-clierr';
    const { stores, log } = await receiver(name, CARA);
    const { msgType, payload } = await encryptText(senderStores, SENDER_ID, CARA, 'mail vs 000 file');
    expect(msgType).toBe('prekey');

    // identity.json unreadable: `readCredentialGuarded` refuses with fixed
    // prose plus a shape-checked errno — the ONE CliError provenance whose
    // message is certified value-free and may be shown verbatim.
    const idPath = join(clientDir(name), 'identity.json');
    chmodSync(idPath, 0o000);
    const msgId = ulid();
    let attempt: Awaited<ReturnType<typeof deliverTo>>;
    try {
      attempt = await deliverTo(name, CARA, stores, log, { msgId, msgType, payload });
    } finally {
      chmodSync(idPath, 0o600);
    }

    expect(attempt.ws.acked(msgId)).toBe(false);
    const joined = attempt.notes.join('\n');
    expect(joined).toContain('left on the server, will retry');
    expect(joined).toContain('the account credential file could not be read (EACCES)');
    expect(joined).not.toContain(name);
    expect(joined).not.toContain(clientDir(name));
  });

  it('a ratchet-lock refusal prints fixed prose — never lock.ts’s path-bearing remedy', async () => {
    const DANA = '01LOGLEAKDLOCKDLOCKDLOCKDL';
    const name = 'logleak-dlock';
    const { stores, log } = await receiver(name, DANA);
    const { msgType, payload } = await encryptText(senderStores, SENDER_ID, DANA, 'mail vs held lock');

    // A fresh PLAIN FILE at the lock path: `ensureLockDir` classifies it as a
    // held pre-redesign lock and refuses fast with a CliError whose message
    // deliberately embeds the path (`rm ${lockPath}`) — correct at top level,
    // forbidden in a note.
    const lockPath = stores.ratchetLockPath();
    rmSync(lockPath, { recursive: true, force: true });
    writeFileSync(lockPath, 'held', { mode: 0o600 });
    const msgId = ulid();
    let attempt: Awaited<ReturnType<typeof deliverTo>>;
    try {
      attempt = await deliverTo(name, DANA, stores, log, { msgId, msgType, payload });
    } finally {
      unlinkSync(lockPath);
    }

    expect(attempt.ws.acked(msgId)).toBe(false);
    expect(stores.hasSeen(msgId)).toBe(false);
    const joined = attempt.notes.join('\n');
    expect(joined).toContain('left on the server, will retry');
    expect(joined).toContain('ratchet lock');
    expect(joined).not.toContain(name);
    expect(joined).not.toContain(clientDir(name));
  });
});

describe('the spool-failure and render-failure notes: errno slot, never exception text', () => {
  it('a spool write failure prints its errno and the custody pointer, not the error’s own path', async () => {
    const ERIN = '01LOGLEAKSPOOLSPOOLSPOOLSP';
    const name = 'logleak-spool';
    const { stores, log } = await receiver(name, ERIN);
    const { msgType, payload } = await encryptText(senderStores, SENDER_ID, ERIN, 'spooled text');

    const planted = "/planted/other-account/messages.jsonl";
    const spy = vi.spyOn(log, 'append').mockImplementation(() => {
      throw Object.assign(new Error(`ENOSPC: no space left on device, open '${planted}'`), {
        code: 'ENOSPC',
      });
    });
    const msgId = ulid();
    let attempt: Awaited<ReturnType<typeof deliverTo>>;
    try {
      attempt = await deliverTo(name, ERIN, stores, log, { msgId, msgType, payload });
    } finally {
      spy.mockRestore();
    }

    expect(attempt.ws.acked(msgId)).toBe(false);
    const joined = attempt.notes.join('\n');
    expect(joined).toContain('message log write failed (ENOSPC)');
    // The custody pointer is the one path that travels ON PURPOSE (see the
    // inline comment at the note): the quarantine location.
    expect(joined).toContain('preserved at');
    // The exception's own text — with whatever path it quotes — does not.
    expect(joined).not.toContain(planted);
  });

  it('a render failure names the id, the errno slot, and never the exception text', async () => {
    const FAYE = '01LOGLEAKRENDERRENDERRENDE';
    const name = 'logleak-render';
    const { stores, log } = await receiver(name, FAYE);
    const { msgType, payload } = await encryptText(senderStores, SENDER_ID, FAYE, 'shown text');

    const msgId = ulid();
    const attempt = await deliverTo(name, FAYE, stores, log, { msgId, msgType, payload }, () =>
      Object.assign(new Error('write failed on /planted/reporter/path'), { code: 'EPIPE' }),
    );

    // Delivered (spooled + acked exactly once) — the render came after the ack.
    expect(attempt.ws.sent.filter(f => f.type === 'ack').length).toBe(1);
    const joined = attempt.notes.join('\n');
    expect(joined).toContain(`could not render msgId=${msgId}`);
    expect(joined).toContain('(EPIPE)');
    expect(joined).not.toContain('/planted/reporter/path');
  });
});

describe('the tamper note: stripped and bounded, exactly like a server field', () => {
  it('an undecryptable error with control bytes and an oversize message is sanitized', async () => {
    const GENA = '01LOGLEAKTAMPERTAMPERTAMPE';
    const name = 'logleak-tamper';
    const { stores, log } = await receiver(name, GENA);

    const msgId = ulid();
    const attempt = await deliverTo(name, GENA, stores, log, {
      msgId,
      msgType: 'ciphertext',
      payload: 'EVIL-INJECT',
    });

    // Purge semantics unchanged: seen, acked, rejected loudly.
    expect(attempt.ws.acked(msgId)).toBe(true);
    expect(stores.hasSeen(msgId)).toBe(true);
    const note = attempt.notes.find(n => n.includes('DECRYPT FAILED'));
    expect(note).toBeDefined();
    expect(note).not.toMatch(CONTROL);
    // Bounded: the 300-X tail is cut at the 200-char display bound.
    expect(note).toContain('…');
    expect(note).not.toContain('X'.repeat(250));
  });
});

describe('describeLocalFailure / localErrno — the rule itself', () => {
  const cleanProbe = { arm: () => {}, failed: () => false, failure: () => undefined };

  it('an exotic code cannot smuggle text through the errno slot', () => {
    expect(localErrno(Object.assign(new Error('x'), { code: 'EVIL text /with/path' }))).toBe(
      'unclassified',
    );
    expect(localErrno(Object.assign(new Error('x'), { code: 42 }))).toBe('unclassified');
    expect(localErrno(null)).toBe('unclassified');
    expect(localErrno(Object.assign(new Error('x'), { code: 'ENOSPC' }))).toBe('ENOSPC');
  });

  it('a DIRECT CliError is described by fixed prose, never its message', () => {
    const err = new CliError(EXIT.ERROR, 'remedy with /secret/account/path embedded');
    const text = describeLocalFailure(err, cleanProbe);
    expect(text).toContain('ratchet lock');
    expect(text).not.toContain('/secret/account/path');
  });

  it('a store-boundary CliError passes its certified message through', () => {
    const original = new CliError(EXIT.AUTH, 'fixed certified prose');
    const probe = { arm: () => {}, failed: () => true, failure: () => original };
    expect(describeLocalFailure(new Error('wrapper with /path'), probe)).toBe(
      'fixed certified prose',
    );
  });

  it('a store-boundary fs error is described by its errno alone', () => {
    const original = Object.assign(new Error("ENOSPC: … open '/home/acct/sessions/x.bin.tmp'"), {
      code: 'ENOSPC',
    });
    const probe = { arm: () => {}, failed: () => true, failure: () => original };
    const text = describeLocalFailure(new Error('wrapper'), probe);
    expect(text).toContain('(ENOSPC)');
    expect(text).not.toContain('/home/acct');
  });
});

describe('the failure describer cannot itself throw (an earlier revision review)', () => {
  // A reviewer demonstrated that reading `.code` off a hostile error object
  // throws INSIDE the failure handler — a Proxy whose trap throws, or a
  // getter that does. It degraded safely through the outer frame catch, so
  // this is hardening rather than a repair. It is pinned because the shape it
  // prevents is the one that makes an incident unreadable: an exception
  // raised by the code whose only job is to explain an exception.
  const hostile: [string, unknown][] = [
    ['a Proxy whose get trap throws', new Proxy({}, { get() { throw new Error('trap'); } })],
    ['a getter that throws', { get code(): string { throw new Error('getter'); } }],
    ['a null-prototype object', Object.assign(Object.create(null), { code: 'ENOSPC' })],
    ['a Symbol code', { code: Symbol('nope') }],
    ['null', null],
    ['undefined', undefined],
  ];

  for (const [label, err] of hostile) {
    it(`survives ${label}`, () => {
      expect(() => localErrno(err)).not.toThrow();
      const out = localErrno(err);
      expect(typeof out).toBe('string');
      // Only a real errno may travel; everything else degrades to the marker.
      expect(out === 'unclassified' || /^E[A-Z0-9]{1,16}$/.test(out)).toBe(true);
    });
  }

  it('still reports a genuine errno', () => {
    expect(localErrno(Object.assign(new Error('x'), { code: 'EACCES' }))).toBe('EACCES');
  });
});
