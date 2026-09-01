import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { PrekeyBundle } from '@tacendum/shared';

/**
 * The traffic-analysis remediation — does the ciphertext SIZE of the phone's
 * approval answer reveal the decision to the relay?
 *
 * The shipped answer channel is an ordinary reply (ADOPTED decision 1,
 * `approval-envelope.ts`): the phone's `sendReply` (`app/src/messaging.ts`)
 * composes `encodeEnvelope({tcm:'reply', ref, ofs, text})` where `text` is the
 * whole-message verb `approve` or `deny` (`attend.ts`: exact, case-insensitive,
 * whole-message — so these two strings are the real population, not a sample).
 * `encodeEnvelope` stringifies the zod-parsed object, so the wire bytes follow
 * `ReplyEnvelope`'s shape order exactly:
 *
 *   {"tcm":"reply","ref":"<26-char ULID>","ofs":false,"text":"approve"}   79 B
 *   {"tcm":"reply","ref":"<26-char ULID>","ofs":false,"text":"deny"}      76 B
 *
 * (`ofs` is false: the prompt is an incoming row on the phone.) A 3-byte
 * plaintext difference. THE QUESTION this gate answers, and re-answers so the
 * number in the spike notes cannot
 * rot: does that difference survive libsignal encryption into a frame-size
 * difference the relay can read?
 *
 * MEASURED ANSWER (2026-08-13, libsignal via this repo's pinned version; the
 * assertions below re-prove it on every run): NO. The Signal double ratchet
 * encrypts the message body with AES-256-CBC + PKCS#7, so the plaintext is
 * padded to a 16-byte block boundary before any byte reaches the wire. Both
 * answer plaintexts (76 B and 79 B) land in the same block bucket, so the
 * SignalMessage, the PreKeySignalMessage, and the base64 payload the server
 * sees are IDENTICAL in length for approve and deny — on an established
 * ratchet, on a first (prekey) frame, at any chain depth, for every ref. The
 * leak is message-LENGTH-class only, and the class is shared with every reply
 * whose text is 1–7 bytes — the bucket edge sits at an 8-byte text, which the
 * edge probe below pins.
 *
 * Method is gate.send-cap.test.ts's: REAL libsignal stores, REAL sessions,
 * nothing mocked — no transport is even involved, because `encryptText`
 * returns exactly the `{msgType, payload}` the ws frame carries and
 * `MAX_PAYLOAD_B64_LENGTH` is checked against (frames.ts). Every probe frame
 * is decrypted by the peer to prove the measured bytes are genuine deliverable
 * frames, not artifacts. The CLI's libsignal is the app's wire format: the
 * Signal protocol fixes the ciphertext layout, so the answer direction
 * (phone→CLI) produces the same sizes this harness measures.
 *
 * Run with TACENDUM_MEASURE=1 to print the raw table the spike doc records.
 */

const h = mkdtempSync(join(tmpdir(), 'tacendum-answer-size-'));
process.env.TACENDUM_HOME = h;

const { FileStores } = await import('../src/stores.js');
const { decryptEnvelope, encryptText, establishSession, generateAndStoreKeys } = await import(
  '../src/messaging.js'
);

afterAll(() => {
  delete process.env.TACENDUM_HOME;
  rmSync(h, { recursive: true, force: true });
});

const ALICE = '01ALICEALICEALICEALICEALIC'; // the phone (answers)
const BOB = '01BOBBOBBOBBOBBOBBOBBOBBOB'; // the CLI account (asked)

/** Five refs spanning the ULID alphabet — every msgId is 26 ASCII chars, so
 * the ref can never move the size; asserted, not assumed. */
const REFS = [
  '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  '01BX5ZZKBKACTAV9WEVGEMMVRZ',
  '01HZYQ3E0DP6JVMB8W9NR7YTKM',
  '01J5CQ3W9V0000000000000000',
  '7ZZZZZZZZZZZZZZZZZZZZZZZZ0',
];

/**
 * The answer bytes EXACTLY as the phone sends them. Insertion order here is
 * `ReplyEnvelope`'s shape order (tcm, ref, ofs, text — app/src/envelope.ts),
 * which is what `encodeEnvelope`'s `JSON.stringify(parsed.data)` emits: zod
 * rebuilds the object in shape order, so schema order IS wire order.
 */
function answerBody(ref: string, text: string): string {
  expect(ref).toHaveLength(26);
  return JSON.stringify({ tcm: 'reply', ref, ofs: false, text });
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

type Stores = InstanceType<typeof FileStores>;

/** A real alice→bob session, still in its prekey (unacknowledged) state. */
async function freshPair(name: string): Promise<{ a: Stores; b: Stores }> {
  const a = new FileStores(`${name}-a`);
  const b = new FileStores(`${name}-b`);
  await generateAndStoreKeys(a);
  const bUp = await generateAndStoreKeys(b);
  await establishSession(a, ALICE, bundleFrom(BOB, bUp));
  return { a, b };
}

/** The same pair after a full round trip, so alice's next frame is an
 * ordinary SignalMessage on an established ratchet. */
async function establishedPair(name: string): Promise<{ a: Stores; b: Stores }> {
  const { a, b } = await freshPair(name);
  const f1 = await encryptText(a, ALICE, BOB, 'warmup');
  expect(f1.msgType).toBe('prekey');
  await decryptEnvelope(b, BOB, ALICE, f1.msgType, f1.payload);
  const f2 = await encryptText(b, BOB, ALICE, 'ack');
  expect(f2.msgType).toBe('ciphertext');
  await decryptEnvelope(a, ALICE, BOB, f2.msgType, f2.payload);
  return { a, b };
}

type Frame = { msgType: 'prekey' | 'ciphertext'; payload: string };

/** Both lengths the relay can observe: the base64 payload characters (what
 * `MAX_PAYLOAD_B64_LENGTH` counts) and the serialized ciphertext bytes. */
function sizes(f: Frame): { b64: number; raw: number } {
  return { b64: f.payload.length, raw: Buffer.from(f.payload, 'base64').byteLength };
}

const MEASURE = process.env.TACENDUM_MEASURE === '1';
function record(line: string): void {
  if (MEASURE) console.log(`MEASURE ${line}`);
}

/**
 * Encrypt approve and deny AT EQUAL CHAIN POSITIONS on one session (a burned
 * warmup moves both probes past counter 0, whose varint can differ), decrypt
 * both at the peer to prove the frames genuine, and return the sizes. Order
 * alternates at the call site so "approve first" can never hide in the chain.
 */
async function probePair(
  pair: { a: Stores; b: Stores },
  ref: string,
  first: 'approve' | 'deny',
  expectType: Frame['msgType'],
): Promise<{ approve: { b64: number; raw: number }; deny: { b64: number; raw: number } }> {
  const { a, b } = pair;
  const w = await encryptText(a, ALICE, BOB, 'w');
  await decryptEnvelope(b, BOB, ALICE, w.msgType, w.payload);
  const second = first === 'approve' ? 'deny' : 'approve';
  const out = {} as Record<'approve' | 'deny', { b64: number; raw: number }>;
  for (const verb of [first, second]) {
    const body = answerBody(ref, verb);
    const frame = await encryptText(a, ALICE, BOB, body);
    expect(frame.msgType).toBe(expectType);
    expect(await decryptEnvelope(b, BOB, ALICE, frame.msgType, frame.payload)).toBe(body);
    out[verb] = sizes(frame);
  }
  return out;
}

describe('traffic analysis: the relay cannot read the decision from the frame size', () => {
  it('the plaintexts differ by exactly 3 bytes — the premise being measured', () => {
    const approve = answerBody(REFS[0], 'approve');
    const deny = answerBody(REFS[0], 'deny');
    expect(Buffer.byteLength(approve, 'utf8')).toBe(79);
    expect(Buffer.byteLength(deny, 'utf8')).toBe(76);
  });

  it('established ratchet: approve and deny frames are byte-identical, across refs', async () => {
    const seen = new Set<string>();
    for (const [i, ref] of REFS.entries()) {
      const pair = await establishedPair(`est-${i}`);
      const r = await probePair(pair, ref, i % 2 === 0 ? 'approve' : 'deny', 'ciphertext');
      record(`est ref=${ref} approve raw=${r.approve.raw} b64=${r.approve.b64} deny raw=${r.deny.raw} b64=${r.deny.b64}`);
      // THE CLAIM: zero delta, in both observable forms.
      expect(r.approve.raw).toBe(r.deny.raw);
      expect(r.approve.b64).toBe(r.deny.b64);
      seen.add(`${r.approve.raw}/${r.approve.b64}`);
    }
    // And stable across refs: one size class, not five coincidences.
    expect(seen.size).toBe(1);
  });

  it('prekey frame (first after pair/re-pair): approve and deny are byte-identical', async () => {
    const rawSpread: number[] = [];
    for (const [i, ref] of REFS.entries()) {
      const pair = await freshPair(`pk-${i}`);
      const r = await probePair(pair, ref, i % 2 === 0 ? 'deny' : 'approve', 'prekey');
      record(`prekey ref=${ref} approve raw=${r.approve.raw} b64=${r.approve.b64} deny raw=${r.deny.raw} b64=${r.deny.b64}`);
      expect(r.approve.raw).toBe(r.deny.raw);
      expect(r.approve.b64).toBe(r.deny.b64);
      rawSpread.push(r.approve.raw);
    }
    // Across PAIRS the prekey envelope may wobble a few bytes (prekey-id
    // varints differ per pair) — that wobble is pair identity, not decision,
    // and it must stay small enough that it could never smuggle a verb.
    const min = Math.min(...rawSpread);
    const max = Math.max(...rawSpread);
    record(`prekey raw spread across pairs: ${min}..${max}`);
    expect(max - min).toBeLessThanOrEqual(4);
  });

  it('deep ratchet: counter growth moves both sizes together, never apart', async () => {
    const pair = await establishedPair('deep');
    // Push the sending chain past counter 127 so its varint widens — the one
    // legitimate size change a long conversation produces.
    for (let i = 0; i < 130; i += 1) {
      await encryptText(pair.a, ALICE, BOB, 'filler');
    }
    const r = await probePair(pair, REFS[0], 'approve', 'ciphertext');
    record(`deep est approve raw=${r.approve.raw} b64=${r.approve.b64} deny raw=${r.deny.raw} b64=${r.deny.b64}`);
    expect(r.approve.raw).toBe(r.deny.raw);
    expect(r.approve.b64).toBe(r.deny.b64);
  });

  it('WHY the delta vanishes, pinned: the cipher pads to 16-byte blocks, and both answers share a bucket whose edge is an 8-byte text', async () => {
    const pair = await establishedPair('edge');
    const { a, b } = pair;
    const w = await encryptText(a, ALICE, BOB, 'w');
    await decryptEnvelope(b, BOB, ALICE, w.msgType, w.payload);
    const rawFor = async (text: string): Promise<number> => {
      const body = answerBody(REFS[0], text);
      const frame = await encryptText(a, ALICE, BOB, body);
      expect(await decryptEnvelope(b, BOB, ALICE, frame.msgType, frame.payload)).toBe(body);
      return sizes(frame).raw;
    };
    const one = await rawFor('x'); //            73 B total
    const four = await rawFor('nope'); //        76 B — deny's length
    const seven = await rawFor('whyyes!'); //    79 B — approve's length
    const eight = await rawFor('approved'); //   80 B — first size that differs
    record(`edge raw: len1=${one} len4=${four} len7=${seven} len8=${eight}`);
    // 1..7-byte reply texts are ONE size class — the leak is length class,
    // "some short reply", not the decision...
    expect(new Set([one, four, seven]).size).toBe(1);
    // ...and the class edge is exactly the cipher's 16-byte block boundary.
    expect(eight).toBe(one + 16);
  });

  it('an approval answer is size-indistinguishable from ordinary chat of the same length class', async () => {
    const pair = await establishedPair('chat');
    const { a, b } = pair;
    const w = await encryptText(a, ALICE, BOB, 'w');
    await decryptEnvelope(b, BOB, ALICE, w.msgType, w.payload);
    // An ordinary (non-envelope) chat message whose plaintext lands in the
    // same block bucket as the 76/79-byte answers…
    const chat = 'sounds good — let me look at it tomorrow morning, and thanks again for this!!';
    expect(Buffer.byteLength(chat, 'utf8')).toBe(79); // em dash is 3 bytes
    const chatFrame = await encryptText(a, ALICE, BOB, chat);
    expect(await decryptEnvelope(b, BOB, ALICE, chatFrame.msgType, chatFrame.payload)).toBe(chat);
    // …produces the very same frame sizes as the answers do.
    const body = answerBody(REFS[1], 'approve');
    const answerFrame = await encryptText(a, ALICE, BOB, body);
    expect(await decryptEnvelope(b, BOB, ALICE, answerFrame.msgType, answerFrame.payload)).toBe(
      body,
    );
    record(`chat raw=${sizes(chatFrame).raw} answer raw=${sizes(answerFrame).raw}`);
    expect(sizes(chatFrame).raw).toBe(sizes(answerFrame).raw);
    expect(sizes(chatFrame).b64).toBe(sizes(answerFrame).b64);
  });
});
