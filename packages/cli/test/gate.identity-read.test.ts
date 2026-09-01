/**
 * IDENTITY-READ CLASSIFICATION (rank 1) and the credential
 * fragment leak, both introduced or exposed by the change that rewired
 * `FileIdentityKeyStore.exists()/load()` through `readCredential`.
 *
 * The rank-1 chain, reproduced here with real libsignal end to end:
 * `readCredential` THROWS by design when the keychain is locked or
 * unreachable (refusing beats answering "absent"), libsignal wraps that
 * CliError — like every store-callback throw — in a code-Generic
 * LibSignalErrorBase, `classifyDecryptFailure` saw neither a CliError nor a
 * probed WRITE failure, answered 'undecryptable', and the tamper branch
 * ACKED — deleting the server's only copy of a message that was fully
 * retryable once the operator unlocked their keychain.
 *
 * The fix under test is NOT "identity reads were added to the probe's list".
 * The list was the defect (this is the third store error to fall through
 * one): stores.ts now records EVERY throw that crosses the store boundary —
 * every method of every store object libsignal touches, reads included,
 * enumerated from the real prototype chains at construction
 * (`recordThrowsAcrossStoreBoundary`) — and the probe both inbound paths arm
 * merely reads that record. Tests 2 and 3 pin the generality with store
 * errors the old write-list could never see: a missing one-time prekey file
 * and a corrupt session record.
 *
 * Sabotage handles, each verified during this round:
 *  - drop `this.identity` (or the whole loop) from the instrumented list in
 *    the FileStores constructor -> tests 1 and 4 ack the message away;
 *  - drop the loop entirely -> gate.acksafety's persistence case fails too, proving the
 *    old write coverage now rides the same mechanism;
 *  - revert `parseCredential` to a bare `JSON.parse(blob)` -> test 4's
 *    SECRET assertions fail with the exact "SECRET_PAR" fragment the
 *    external review watched reach --json;
 *  - revert `readCredentialGuarded` to a naked `readCredential` -> test 5
 *    sees the account path and name ride an EACCES message.
 */
import { describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monotonicFactory } from 'ulid';
import type { ClientFrame, PrekeyBundle, ServerFrame } from '@tacendum/shared';

const home = mkdtempSync(join(tmpdir(), 'tacendum-idread-'));
process.env.TACENDUM_HOME = home;

const { FileStores } = await import('../src/stores.js');
const { generateAndStoreKeys, establishSession, encryptText, decryptEnvelope } = await import(
  '../src/messaging.js'
);
const { attachInbound } = await import('../src/inbound.js');
const { MessageLog } = await import('../src/msglog.js');
const { CliError, EXIT } = await import('../src/exit.js');
const { clientDir } = await import('../src/config.js');
type WsClient = import('../src/wsclient.js').WsClient;
type Reporter = import('../src/output.js').Reporter;

const ulid = monotonicFactory();

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

/** The two WsClient methods the inbound policy uses, capturable. */
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

const SENDER_ID = '01IDREADSENDERSENDERSENDER';

// One sender, one session per receiver — each test breaks a different
// receiver-side store, so each receiver gets its own account.
const senderStores = new FileStores('idread-sender');
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
) {
  const ws = new FakeWs();
  const { r, lines, notes } = fakeReporter();
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

describe('rank 1 — an identity-read refusal is a LOCAL failure, never tamper', () => {
  it('locked keychain: the frame stays queued, and decrypts after the credential returns', async () => {
    const BOB = '01IDREADLOCKEDLOCKEDLOCKED';
    const name = 'idread-locked';
    const { stores, log } = await receiver(name, BOB);
    const { msgType, payload } = await encryptText(
      senderStores,
      SENDER_ID,
      BOB,
      'mail that must survive a locked keychain',
    );
    expect(msgType).toBe('prekey');
    const msgId = ulid();

    // The gate's repro state: the credential lives in the OS keychain (the
    // marker says so, the file is gone) and the keychain cannot be reached —
    // a `security` that answers "interaction is not allowed", which
    // `readCredential` classifies as failed and REFUSES with a CliError.
    const dir = clientDir(name);
    const idPath = join(dir, 'identity.json');
    const credential = readFileSync(idPath, 'utf8');
    const markerPath = join(dir, 'credential-backend.json');
    writeFileSync(markerPath, JSON.stringify({ backend: 'macos-keychain' }), { mode: 0o600 });
    unlinkSync(idPath);
    const shimDir = join(home, 'shim-locked-keychain');
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(
      join(shimDir, 'security'),
      '#!/bin/sh\necho "security: SecKeychainSearchCopyNext: The user interaction is not allowed." >&2\nexit 1\n',
      { mode: 0o755 },
    );
    const realPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${realPath}`;
    let attempt: Awaited<ReturnType<typeof deliverTo>>;
    try {
      attempt = await deliverTo(name, BOB, stores, log, { msgId, msgType, payload });
    } finally {
      process.env.PATH = realPath;
    }

    // The old chain: wrapper Generic -> 'undecryptable' -> seen, acked, gone.
    // The row must stay QUEUED — not seen, not acked — and the operator must
    // hear "local, will retry", never "rejected".
    expect(attempt.ws.acked(msgId)).toBe(false);
    expect(stores.hasSeen(msgId)).toBe(false);
    expect(attempt.notes.some(n => n.includes('left on the server, will retry'))).toBe(true);
    expect(attempt.notes.some(n => n.includes('DECRYPT FAILED'))).toBe(false);
    // Nothing was half-done: no session pinned, no one-time prekey consumed —
    // which is what makes the redelivery below decryptable at all.
    expect(existsSync(join(dir, 'sessions', `${SENDER_ID}.1.bin`))).toBe(false);
    expect(stores.prekeys.count()).toBe(100);
    // And the diagnostics named neither the account nor the credential.
    expect(attempt.notes.join('\n')).not.toContain(name);

    // The operator unlocks the keychain (here: the credential file returns).
    // The server still holds the unacked row; the identical bytes decrypt,
    // spool, and only then ack.
    writeFileSync(idPath, credential, { mode: 0o600 });
    unlinkSync(markerPath);
    const retry = await deliverTo(name, BOB, stores, log, { msgId, msgType, payload });
    expect(retry.ws.acked(msgId)).toBe(true);
    expect(stores.hasSeen(msgId)).toBe(true);
    expect(log.read().some(rec => rec.id === msgId && rec.text.includes('locked keychain'))).toBe(
      true,
    );
  });
});

describe('the mechanism is the boundary, not a list (a third kind cannot fall through)', () => {
  it('a missing one-time prekey file — a store READ absence — leaves the row queued', async () => {
    const CAROL = '01IDREADNOPREKEYNOPREKEYNO';
    const name = 'idread-noprekey';
    const { stores, log } = await receiver(name, CAROL);
    const { msgType, payload } = await encryptText(
      senderStores,
      SENDER_ID,
      CAROL,
      'mail against a lost prekey file',
    );
    expect(msgType).toBe('prekey');

    // Every private half vanishes (a half-restored backup): `getPreKey`
    // throws a plain Error — not a CliError, not a write, invisible to both
    // of the old guards. Only boundary-wide recording classifies it as OURS.
    const prekeysDir = join(clientDir(name), 'prekeys');
    for (let id = 1; id <= 100; id++) {
      const path = join(prekeysDir, `${id}.bin`);
      if (existsSync(path)) unlinkSync(path);
    }

    const msgId = ulid();
    const { ws, notes } = await deliverTo(name, CAROL, stores, log, { msgId, msgType, payload });
    expect(ws.acked(msgId)).toBe(false);
    expect(stores.hasSeen(msgId)).toBe(false);
    expect(notes.some(n => n.includes('left on the server, will retry'))).toBe(true);
    expect(notes.some(n => n.includes('DECRYPT FAILED'))).toBe(false);
  });

  it('a corrupt session record — a store READ throw on the ciphertext path — is local, and recovery decrypts the same bytes', async () => {
    const DAVE = '01IDREADCORRUPTCORRUPTCORR';
    const name = 'idread-corrupt';
    const { stores, log } = await receiver(name, DAVE);

    // Complete the handshake so the next sender envelope is 'ciphertext' —
    // the type that decrypts from the on-disk session alone.
    const hello = await encryptText(senderStores, SENDER_ID, DAVE, 'handshake');
    const first = await deliverTo(name, DAVE, stores, log, {
      msgId: ulid(),
      msgType: hello.msgType,
      payload: hello.payload,
    });
    expect(first.ws.sent.some(f => f.type === 'ack')).toBe(true);
    const back = await encryptText(stores, DAVE, SENDER_ID, 'handshake reply');
    await decryptEnvelope(senderStores, SENDER_ID, DAVE, back.msgType, back.payload);

    const { msgType, payload } = await encryptText(
      senderStores,
      SENDER_ID,
      DAVE,
      'mail across a corrupted session file',
    );
    expect(msgType).toBe('ciphertext');

    // External damage to OUR ratchet state: SessionRecord.deserialize throws
    // inside getSession. The peer's bytes are blameless, so this must be
    // local — the old classifier called it tamper and acked the mail away.
    const sessionPath = join(clientDir(name), 'sessions', `${SENDER_ID}.1.bin`);
    const good = readFileSync(sessionPath);
    writeFileSync(sessionPath, Buffer.from('not a session record'), { mode: 0o600 });
    const msgId = ulid();
    const broken = await deliverTo(name, DAVE, stores, log, { msgId, msgType, payload });
    expect(broken.ws.acked(msgId)).toBe(false);
    expect(stores.hasSeen(msgId)).toBe(false);
    expect(broken.notes.some(n => n.includes('left on the server, will retry'))).toBe(true);

    // The operator restores the file from backup; the still-queued row
    // decrypts on redelivery.
    writeFileSync(sessionPath, good, { mode: 0o600 });
    const retry = await deliverTo(name, DAVE, stores, log, { msgId, msgType, payload });
    expect(retry.ws.acked(msgId)).toBe(true);
    expect(log.read().some(rec => rec.id === msgId)).toBe(true);
  });
});

describe('secret leak — no credential byte in any exception, diagnostic, or --json', () => {
  it('a malformed credential refuses with fixed prose, never a blob fragment', async () => {
    const ERIN = '01IDREADLEAKLEAKLEAKLEAKLE';
    const name = 'idread-leak';
    const { stores, log } = await receiver(name, ERIN);
    const { msgType, payload } = await encryptText(
      senderStores,
      SENDER_ID,
      ERIN,
      'mail against a mangled credential',
    );

    // The gate's shape: syntactically broken JSON whose next token is key
    // material. Node 22's own SyntaxError for exactly this input is
    // `Unexpected token 'S', ..."KeyPair": SECRET_PAR"... is not valid JSON`
    // — the fragment the gate watched reach decrypt diagnostics and --json.
    const idPath = join(clientDir(name), 'identity.json');
    writeFileSync(idPath, '{"identityKeyPair": SECRET_PART_OF_THE_CREDENTIAL}', { mode: 0o600 });

    // Direct read: a fixed AUTH refusal, no blob bytes.
    let direct: unknown;
    try {
      stores.identity.getPublicIdentityKey();
      expect.unreachable('a malformed credential must refuse');
    } catch (err) {
      direct = err;
    }
    expect(direct).toBeInstanceOf(CliError);
    expect((direct as InstanceType<typeof CliError>).exitCode).toBe(EXIT.AUTH);
    expect(String(direct)).not.toContain('SECRET');

    // Through the decrypt: still queued (a restorable credential is a local
    // problem), and no surface — notes, json lines, the wrapped error chain —
    // carries a blob byte.
    const msgId = ulid();
    const { ws, lines, notes } = await deliverTo(name, ERIN, stores, log, {
      msgId,
      msgType,
      payload,
    });
    expect(ws.acked(msgId)).toBe(false);
    expect(stores.hasSeen(msgId)).toBe(false);
    expect(notes.join('\n')).not.toContain('SECRET');
    expect(JSON.stringify(lines)).not.toContain('SECRET');
    await expect(
      decryptEnvelope(stores, ERIN, SENDER_ID, msgType, payload),
    ).rejects.toSatisfy((err: unknown) => !String(err).includes('SECRET'));
  });

  it('an unreadable credential file names the errno, never the path or the account', () => {
    const name = 'idread-eacces';
    const stores = new FileStores(name);
    // A registered account whose file the process cannot read.
    writeFileSync(join(clientDir(name), 'identity.json'), '{"identityKeyPair":"x","registrationId":1}', {
      mode: 0o600,
    });
    chmodSync(join(clientDir(name), 'identity.json'), 0o000);
    try {
      let thrown: unknown;
      try {
        stores.identity.getPublicIdentityKey();
        expect.unreachable('an unreadable credential must refuse');
      } catch (err) {
        thrown = err;
      }
      // A raw fs error here reads `EACCES: permission denied, open
      // '$TACENDUM_HOME/idread-eacces/identity.json'` — the account name on
      // an operator-facing surface. What may travel: fixed prose + errno.
      expect(thrown).toBeInstanceOf(CliError);
      expect((thrown as InstanceType<typeof CliError>).exitCode).toBe(EXIT.ERROR);
      const message = (thrown as Error).message;
      expect(message).toContain('EACCES');
      expect(message).not.toContain(name);
      expect(message).not.toContain(home);
      expect(message).not.toContain('identity.json');
    } finally {
      chmodSync(join(clientDir(name), 'identity.json'), 0o600);
    }
  });
});
