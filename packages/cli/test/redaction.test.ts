import { afterEach, describe, expect, it } from 'vitest';
import {
  credentialMark,
  forgetCredentials,
  guardCredential,
  redactCredentials,
  sanitizeForTerminal,
  sanitizeServerField,
} from '../src/render.js';

/**
 * THE CHOKEPOINT'S OWN PROPERTIES, asked directly.
 *
 * `gate.credential-echo.test.ts` proves the four sinks a server can reach
 * through the real binary. This file pins the decisions underneath them, which
 * an end-to-end test can only observe indirectly: what length of run counts as
 * a disclosure, that the needle survives the mangling the sanitizers apply,
 * and that a process holding no credential pays nothing and changes nothing.
 */

const TOKEN = 'Zq3Rk8Xv1TbN7wLpD4hJ2msY6ceA0uGfWi5oQxE9rSt';
const MARK = '[credential withheld]';

afterEach(() => forgetCredentials());

describe('redactCredentials', () => {
  it('is the identity until something registers a credential', () => {
    expect(redactCredentials(`bearer ${TOKEN} here`)).toBe(`bearer ${TOKEN} here`);
    expect(sanitizeForTerminal(`bearer ${TOKEN}`)).toBe(`bearer ${TOKEN}`);
  });

  it('removes the whole contiguous run, not just the window that found it', () => {
    guardCredential(TOKEN);
    expect(redactCredentials(`upstream rejected Bearer ${TOKEN} at 12:04`)).toBe(
      `upstream rejected Bearer ${MARK} at 12:04`,
    );
  });

  it('removes an 8-character fragment — the length V8 and the header quoter cut at', () => {
    guardCredential(TOKEN);
    // What V8 leaves of a body that is not JSON: ten characters, quoted.
    const v8 = `Unexpected token 'Z', "${TOKEN.slice(0, 10)}"... is not valid JSON`;
    expect(redactCredentials(v8)).not.toContain(TOKEN.slice(0, 8));
    expect(redactCredentials(v8)).toContain(MARK);
    // Every 8-character window, wherever it sits in the token.
    for (let i = 0; i + 8 <= TOKEN.length; i++) {
      const run = TOKEN.slice(i, i + 8);
      expect(redactCredentials(`errno EAI_AGAIN ${run} tail`), `window at ${i}`).not.toContain(run);
    }
  });

  it('leaves a 7-character run alone — the false-positive direction is not free', () => {
    guardCredential(TOKEN);
    const short = TOKEN.slice(3, 10);
    expect(short).toHaveLength(7);
    expect(redactCredentials(`getaddrinfo ${short} api.example`)).toContain(short);
  });

  it('finds the needle after the mangling the sanitizers apply', () => {
    // The July leak's exact shape: a stored token with a line break, which
    // reached output with the break flattened to a space. Comparing against
    // the un-mangled value is what let it through.
    const stored = 'LEGACYB1NDSECRET\nTAILPART';
    guardCredential(stored);
    const asPrinted = 'Headers.append: "Bearer LEGACYB1NDSECRET TAILPART" is an invalid header value.';
    expect(redactCredentials(asPrinted)).not.toContain('LEGACYB1ND');
    expect(redactCredentials(asPrinted)).not.toContain('TAILPART');
    // …and through the field sanitizer, which is what actually flattens it.
    expect(sanitizeServerField(`Bearer ${stored}`, 200)).not.toContain('LEGACYB1ND');
  });

  it('declines to treat a value under six characters as a credential', () => {
    guardCredential('tok-1');
    expect(redactCredentials('tok-1 is not a secret')).toBe('tok-1 is not a secret');
  });

  it('redacts before the field bound, so truncation can only cut the marker', () => {
    guardCredential(TOKEN);
    const out = sanitizeServerField(TOKEN, 64);
    expect(out).toBe(MARK);
    expect(out).not.toContain(TOKEN.slice(0, 8));
  });

  it('survives many registrations without unbounding — oldest out first', () => {
    for (let i = 0; i < 80; i++) guardCredential(`credential-number-${i}-aaaaaaaa`);
    // The newest is always the live one, so it is the one that must still be
    // recognised after the cap has evicted.
    //
    // ASSERTED AGAINST THE MARKER IN FORCE, not against the default spelling.
    // These fixtures begin with the word `credential`, so they are exactly the
    // shape that makes `[credential withheld]` unusable — the marker would
    // otherwise carry `credenti` out of the very needle it is standing in for
    // (see "the marker may not contain a protected run" below). The claim here
    // is unchanged and slightly stronger: the value is gone, and something
    // named the removal.
    const out = redactCredentials('x credential-number-79-aaaaaaaa y');
    expect(out).not.toContain('credential-number-79-aaaaaaaa');
    expect(out).toContain(credentialMark());
  });
});

/**
 * THE MARKER MAY NOT CONTAIN A PROTECTED RUN.
 *
 * The chokepoint promises that no `CREDENTIAL_RUN`-length run of a registered
 * value reaches output. `redactRuns` is forward-only and deliberately never
 * rescans what it has emitted — which is what makes it terminate — so the one
 * string it emits without ever checking is its own marker. A token that begins
 * with the word `credential` therefore had `[credential withheld]` printed for
 * it, and that marker contains `credenti`, `redentia` and `edential`: three
 * eight-character runs of the secret, put there by the redactor itself.
 *
 * Contrived — the server would have to mint such a token — and pinned anyway,
 * because an invariant with an exception is not an invariant, and the reader
 * of the next leak will be told this one holds.
 */
describe('the marker itself', () => {
  it('carries no run of the credential it is standing in for', () => {
    // A well-formed 43-character token that happens to open with the marker's
    // own first word. Nothing else about it is unusual.
    const token = 'credentialZq3Rk8Xv1TbN7wLpD4hJ2msY6ceA0uGfW';
    expect(token, 'the fixture is not token-shaped').toHaveLength(43);
    guardCredential(token);
    const out = redactCredentials(`upstream rejected Bearer ${token} at 12:04`);
    expect(out, 'the value survived whole').not.toContain(token);
    for (let i = 0; i + 8 <= token.length; i++) {
      expect(out, `an 8-character run of the credential (offset ${i}) survived`).not.toContain(
        token.slice(i, i + 8),
      );
    }
    // NOT VACUOUS, and this is the half a "contains nothing" assertion cannot
    // make on its own: the diagnosis is intact and the removal is still named
    // in words an operator can read.
    expect(out).toContain('upstream rejected Bearer ');
    expect(out).toContain('at 12:04');
    expect(out).toContain('withheld');
  });

  it('is chosen against every registered needle, not just the one being replaced', () => {
    // `redactCredentials` loops needle after needle over the SAME accumulating
    // string, so a marker emitted for needle A is rescanned by needle B. A
    // marker clean for only the needle that emitted it would be eaten by the
    // next one.
    guardCredential('credentialAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    guardCredential('Zq3Rk8Xv1TbN7wLpD4hJ2msY6ceA0uGfWi5oQxE9rSt');
    const out = redactCredentials('a=credentialAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA b=Zq3Rk8Xv1TbN7wLpD4hJ2msY6ceA0uGfWi5oQxE9rSt');
    expect(out).toBe(`a=${credentialMark()} b=${credentialMark()}`);
  });

  it('falls through to a marker that is clean BY CONSTRUCTION when every phrase collides', () => {
    // One needle that contains a run of every readable candidate at once.
    const token = 'credential withheld secret withheld value withheld';
    guardCredential(token);
    const out = redactCredentials(`server said ${token} here`);
    for (let i = 0; i + 8 <= token.length; i++) {
      expect(out, `an 8-character run of the credential (offset ${i}) survived`).not.toContain(
        token.slice(i, i + 8),
      );
    }
    // The last resort is shorter than the shortest window the detector can
    // form (a needle is at least CREDENTIAL_FLOOR characters), so it cannot
    // contain a run of anything — the guarantee is its LENGTH, not a search.
    expect(credentialMark().length).toBeLessThan(6);
    expect(out).toBe(`server said ${credentialMark()} here`);
  });

  it('composes into valid JSON — no quote, no backslash, in any marker', () => {
    // The structured printers redact the SERIALIZED record (output.ts), so a
    // marker carrying a quote or a backslash would turn a disclosure fix into
    // a parse failure for every `--json` consumer.
    for (const needle of ['credential withheld secret withheld value withheld', 'Zq3Rk8Xv1TbN']) {
      forgetCredentials();
      guardCredential(needle);
      expect(credentialMark()).not.toContain('"');
      expect(credentialMark()).not.toContain('\\');
      expect(JSON.parse(redactCredentials(JSON.stringify({ v: needle })))).toEqual({
        v: credentialMark(),
      });
    }
  });
});
