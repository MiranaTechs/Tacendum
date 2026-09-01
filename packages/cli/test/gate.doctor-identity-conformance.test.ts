import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IdentityKeyPair } from '@signalapp/libsignal-client';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * A GREEN DOCTOR MUST IMPLY THE LOADER WILL ACCEPT.
 *
 * `doctor` exists to be run on a machine somebody already suspects is broken,
 * so an identity line that PASSES for a credential every command then refuses
 * is worse than no line at all: it sends the operator to look somewhere else.
 *
 * It did exactly that. The check accepted any blob whose `identityKeyPair` was
 * a nonempty string, while `FileIdentityKeyStore` (stores.ts) additionally
 * requires a numeric `registrationId` and then goes on to
 * `IdentityKeyPair.deserialize` the base64. So `{"identityKeyPair":"junk"}`
 * produced an entirely green report — identity, profile, network — beside a
 * store that refuses with "the stored credential is not in the format this CLI
 * writes". The gate log had recorded this as a wrong REMEDY printed after a
 * correct refusal, and had the two predicates the wrong way round; it was a
 * false diagnostic.
 *
 * THE TEST IS THE IMPLICATION, not a list of shapes doctor should reject. For
 * every blob in the corpus it asks the REAL store whether an operational read
 * succeeds, asks the REAL `runDoctor` what it says, and requires the first to
 * be true whenever the second is green. A future divergence in EITHER file —
 * a loosened doctor, a tightened store — turns this red, which is the only
 * thing that keeps two implementations of one question from drifting apart.
 */

const home = mkdtempSync(join(tmpdir(), 'tacendum-idconform-'));
process.env.TACENDUM_HOME = home;
// The credential must live in identity.json and nowhere else, or this fixture
// would be probing a developer's real keychain.
process.env.TACENDUM_CREDENTIAL_STORE = 'file';

const { runDoctor } = await import('../src/doctor.js');
const { FileIdentityKeyStore } = await import('../src/stores.js');

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

/**
 * A REAL keypair, serialized the way `initialize` writes one (stores.ts).
 *
 * A fresh one per case on purpose: the corpus is about the PREDICATES, and
 * two cases sharing one key would let a single unlucky serialization decide
 * several verdicts at once.
 */
function realKeyPair(): string {
  return Buffer.from(IdentityKeyPair.generate().serialize()).toString('base64');
}

const goodBlob = (registrationId: unknown, key: string = realKeyPair()): string =>
  JSON.stringify({ identityKeyPair: key, registrationId });

/**
 * THE CORPUS HAS TO SPREAD OVER BOTH PREDICATES' INPUTS, and for one round it
 * did not. It held exactly ONE credential both
 * sides accept — a real key with `registrationId: 4242` — and every other
 * case failed on the key bytes. Two predicates agreeing at a single point is
 * not agreement: tightening either side to `registrationId > 100` left the
 * whole corpus green, while every real account whose registration id came out
 * below that threshold diverged in production. libsignal mints registration
 * ids in the 14-bit range, so most real accounts are below 16384 and a great
 * many are below 100.
 *
 * So the corpus is generated, per dimension:
 *
 *   - REAL keys across the registration-id range, INCLUDING 0 (a number, and
 *     falsy — the shape a truthiness check would silently reject) and 16383
 *     (the top of the 14-bit space). 0 IS DELIBERATELY WIDER THAN THE WRITER:
 *     `generateAndStoreKeys` draws `randomInt(1, 16384)` and so never emits
 *     it, but current libsignal accepts it and the shared schema's
 *     `int().nonnegative()` does too — a loader may accept more than its
 *     writer produces, and pinning the loader to the writer's range would be
 *     a narrowing both sides could adopt together while agreeing perfectly.
 *   - real key, wrong registrationId TYPE — null, boolean, a string that
 *     looks like a number, and absent — each of which is a different way a
 *     hand-edited or older-build file goes wrong.
 *   - real key, right type and WRONG VALUE: a non-integer id (42.5), which
 *     both predicates used to accept and every layer past them refuses.
 *   - real key BYTES corrupted while the shape stays perfect: truncated, and
 *     valid base64 of something that is not a key at all. These are the ones
 *     a shape-only mirror of the store gets wrong, and they are why doctor
 *     deserializes rather than type-checking.
 *   - the document-level shapes, which is what the corpus used to be.
 */
const REGISTRATION_IDS = [0, 1, 42, 100, 101, 16383, 4242];

/** A real serialization with its last byte gone — right shape, wrong bytes. */
function truncatedKey(): string {
  const bytes = Buffer.from(IdentityKeyPair.generate().serialize());
  return bytes.subarray(0, bytes.length - 1).toString('base64');
}

const CORPUS: { label: string; blob: string }[] = [
  ...REGISTRATION_IDS.map(id => ({
    label: `a real credential, registrationId ${id}`,
    blob: goodBlob(id),
  })),
  // 42.5 — a number of the right TYPE and the wrong VALUE, and the case that
  // moved sides. It sat under a `a real credential…` label, which put it in
  // MUST_LOAD, so the corpus PINNED an acceptance the product contradicts:
  // packages/shared declares `registrationId: z.number().int().nonnegative()`
  // and installed libsignal refuses the value at the u32 boundary
  // (`RangeError: cannot convert 42.5 to u32`, measured on 0.98.0). Both
  // predicates said yes, so a correct integer check on either side turned the
  // corpus red — a test pinning a bug. Decided in
  // the PRODUCT: `parseCredential` and `identityLoads` both ask
  // `Number.isInteger` now, and this is a MUST_REFUSE case under its own name.
  { label: 'real key, non-integer registrationId', blob: goodBlob(42.5) },
  // Forward compatibility: a field neither predicate knows must not change
  // either verdict.
  {
    label: 'a real credential with an unknown extra field',
    blob: JSON.stringify({ identityKeyPair: realKeyPair(), registrationId: 7, future: 'x' }),
  },
  // --- real key, wrong registrationId ---------------------------------------
  { label: 'real key, registrationId null', blob: goodBlob(null) },
  { label: 'real key, registrationId true', blob: goodBlob(true) },
  { label: 'real key, registrationId as a string number', blob: goodBlob('4242') },
  {
    label: 'real key, registrationId absent',
    blob: JSON.stringify({ identityKeyPair: realKeyPair() }),
  },
  // --- real shape, corrupted key bytes --------------------------------------
  { label: 'a real key truncated by one byte', blob: goodBlob(4242, truncatedKey()) },
  {
    label: 'valid base64 of garbage',
    blob: goodBlob(4242, Buffer.from('not a serialized identity key pair').toString('base64')),
  },
  { label: 'empty base64 keypair', blob: goodBlob(1, '') },
  // --- the document shapes (the corpus as it stood) -------------------------
  // The blob from the finding: a nonempty string, no registrationId.
  { label: 'identityKeyPair only', blob: '{"identityKeyPair":"junk"}' },
  // A registrationId of the wrong type — the store demands a number.
  { label: 'registrationId as a string', blob: '{"identityKeyPair":"junk","registrationId":"1"}' },
  // Both fields, right types, and bytes libsignal will not deserialize.
  { label: 'well-shaped but undeserializable', blob: '{"identityKeyPair":"junk","registrationId":1}' },
  { label: 'an empty object', blob: '{}' },
  { label: 'an array', blob: '[]' },
  { label: 'a bare null', blob: 'null' },
  { label: 'a number', blob: '7' },
  { label: 'not JSON at all', blob: 'not json' },
];

/** The cases both sides are required to ACCEPT — the liveness control, and
 * the half a tightened predicate breaks. */
const MUST_LOAD = new Set(
  CORPUS.filter(c => c.label.startsWith('a real credential')).map(c => c.label),
);

/** What an operational read does — `getPublicIdentityKey` is the synchronous
 * one, and it is the same `load()` + `deserialize` every send, listen and
 * safety number reaches. */
function loaderAccepts(account: string): boolean {
  try {
    new FileIdentityKeyStore(join(home, account), account).getPublicIdentityKey();
    return true;
  } catch {
    return false;
  }
}

async function identityCheck(account: string): Promise<{ ok: boolean; detail: string }> {
  const results = await runDoctor(account, {
    // No network in this test: the identity check runs before any probe, and
    // the api/clock/session/ws lines are somebody else's subject.
    fetchImpl: () => Promise.reject(new Error('offline')),
    dialWs: () => Promise.reject(new Error('offline')),
    now: () => Date.now(),
  });
  const line = results.find((r) => r.check === 'identity');
  expect(line, 'doctor produced no identity line at all').toBeDefined();
  return { ok: line!.ok, detail: line!.detail };
}

describe('doctor never reports green on an identity the loader will refuse', () => {
  it.each(CORPUS)('$label', async ({ label, blob }) => {
    const account = `id${CORPUS.findIndex((c) => c.label === label)}`;
    // A generated corpus can collide on a label and then quietly test one
    // case twice under two names; the index above is derived from the label,
    // so this is the assertion that keeps it a bijection.
    expect(CORPUS.filter((c) => c.label === label)).toHaveLength(1);
    mkdirSync(join(home, account), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, account, 'identity.json'), blob, { mode: 0o600 });

    const accepts = loaderAccepts(account);
    const line = await identityCheck(account);

    // THE IMPLICATION, in the direction that costs an operator their evening.
    // A doctor that FAILS a credential the loader would have taken is a
    // nuisance; one that PASSES a credential the loader refuses is a lie.
    if (line.ok) {
      expect(
        accepts,
        `doctor said "${line.detail}" for a credential an operational read refuses`,
      ).toBe(true);
    }
    // …and the other direction too, because a doctor that refuses everything
    // would satisfy the implication above while being useless. The two
    // verdicts must AGREE.
    expect(line.ok, `doctor and the loader disagreed (loader accepts=${accepts})`).toBe(accepts);

    // …AND THE VERDICT IS THE EXPECTED ONE, which agreement alone does not
    // give. Two predicates tightened in the SAME way agree perfectly and are
    // both wrong; the corpus knows which cases are real credentials, so it
    // says so. This is the half that makes `registrationId > 100` go red on
    // either side — or on both.
    if (MUST_LOAD.has(label)) {
      expect(accepts, `a REAL credential was refused by the loader: ${label}`).toBe(true);
      expect(line.ok, `a REAL credential was failed by doctor: ${label}`).toBe(true);
    } else {
      expect(accepts, `the loader accepted a credential the corpus calls broken: ${label}`).toBe(
        false,
      );
    }
  });

  it('the corpus spans the registration-id range with credentials both sides accept', () => {
    // The liveness control for the whole file, and it is no longer satisfied
    // by ONE point: two predicates pinned at a single registration id agree
    // while diverging everywhere else, which is the finding this corpus
    // answers (an earlier review).
    expect(MUST_LOAD.size).toBeGreaterThanOrEqual(REGISTRATION_IDS.length);
    for (const id of REGISTRATION_IDS) {
      const label = `a real credential, registrationId ${id}`;
      expect(MUST_LOAD.has(label), `the corpus lost its registrationId ${id} case`).toBe(true);
      expect(
        loaderAccepts(`id${CORPUS.findIndex((c) => c.label === label)}`),
        `the good credential for registrationId ${id} did not load — the fixture is broken`,
      ).toBe(true);
    }
    // …and it still contains blobs both sides refuse, or the agreement above
    // would be satisfiable by two things that always say yes.
    expect(CORPUS.length - MUST_LOAD.size).toBeGreaterThan(0);
  });
});
