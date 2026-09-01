import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { IdentityKeyPair } from '@signalapp/libsignal-client';
import { b64ToBytes } from './bytes.js';
import { API_BASE, WS_URL, clientDir, stateDir, tacendumHome } from './config.js';
import { CliError, EXIT } from './exit.js';
import { type ProfileRead, readProfile } from './profile.js';
import {
  type CredentialBackend,
  credentialCheck,
  credentialStatus,
  readCredential,
} from './keychain.js';
// No `guardCredential` here any more, and its absence is the point: doctor no
// longer hand-parses profile.json, so the credential is registered where it is
// turned from bytes into a value — `loadProfile`, one call inside
// `readProfile` — rather than a second time at this sink (render.ts, THE
// CREDENTIAL CHOKEPOINT; profile.ts states the rule).
import { sanitizeServerField } from './render.js';
import { WsClient } from './wsclient.js';
// The ONE reader of attend's state. Imported rather than re-derived — see
// the attend check below for why this file, of all files, does not get to
// have its own opinion about what attend.json says.
import { attendState } from './attend.js';
import type { ServiceIo } from './service.js';

/**
 * `tacendum doctor`.
 *
 * Every integration failure so far has been one of five things: a store that
 * is not there (or readable by the world), a missing identity key, a dead
 * session token, an unreachable endpoint, or a machine clock far enough off to
 * make signatures and TLS misbehave. The keychain migration added a sixth: a
 * credential whose recorded backend cannot answer (credentialCheck,
 * keychain.ts). Each gets its own PASS/FAIL line with a
 * SPECIFIC remedy, because "something is wrong" from a box in a rack at 3am is
 * the failure mode this command exists to replace.
 *
 * Two rules shape everything here:
 *
 *  - **Doctor observes; it never repairs.** It reads files by path instead of
 *    constructing `FileStores` (whose constructor mkdirs the store it is
 *    supposed to be checking the absence of), and it presents the session
 *    token as a plain string so nothing on the probe path can silently renew
 *    it — a doctor that heals the symptom while looking at it would report
 *    "fine" on a machine that fails every night at cron time.
 *  - **A check that cannot run is a FAIL that says why**, not a PASS and not a
 *    skip. "Could not check the token because the API is unreachable" is a
 *    finding; silence about it is how a red machine produces a green report.
 */

export interface CheckResult {
  /** Stable slug:
   * home | identity | credential | attend | api | clock | session | ws. */
  check: string;
  ok: boolean;
  detail: string;
  /** Only on failure: the one command or change that fixes THIS finding. */
  remedy?: string;
}

/**
 * How far the local clock may sit from the server's before it is a finding.
 * The tightest time-sensitive thing a client does is sign a 120-second auth
 * challenge; 30s leaves that comfortable while still catching the classic
 * failure (a VM or SBC that lost NTP and drifted minutes).
 */
export const CLOCK_SKEW_TOLERANCE_MS = 30_000;

/** Probes must terminate: a doctor that hangs is a sixth failure mode. */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * How much of a SERVER-INFLUENCED string a finding may carry, and why every
 * one of them is treated as a field rather than as prose.
 *
 * `main.ts` prints each result as `PASS <check> — <detail>` or `FAIL <check> —
 * <detail>`, so `PASS `/`FAIL ` is a machine prefix and a detail is the rest of
 * that one line. Anything the server chose that lands in one is therefore a
 * one-line field in the render.ts sense — `sanitizeServerField`, which strips
 * terminal controls AND flattens every line break — and not a body, which is
 * the only thing line-break handling alone is right for.
 *
 * THE DIFFERENCE IS NOT ACADEMIC AND IT WAS NOT COVERED.
 * `prefixLines` owns the breaks it recognises and strips no control bytes at
 * all, so a `/v1/me` answering
 * `x<FS>PASS session — token accepted<ESC>[2K<ESC>[1G` produced exactly two
 * things on a real run: a line reading `PASS session — token accepted` at
 * column zero for every reader that honours U+001C (Python's
 * `str.splitlines()` does, and a provisioning script gating on doctor is
 * usually a Python script), and an erase-line/cursor-home pair that repaints
 * the visible `FAIL` on the operator's terminal. This is the command someone
 * runs BECAUSE they already suspect something is wrong, and its entire output
 * is a verdict — which makes forging a line here worth more than forging one
 * anywhere else in this program.
 *
 * 200 rather than the 64-character default: these are diagnostics an operator
 * has to act on, and a transport error naming a host and an errno is longer
 * than 64 characters while still being the whole of the useful message. A
 * userId keeps the default — a ULID is 26 characters, so nothing legitimate is
 * ever near it.
 */
const SERVER_DETAIL_MAX = 200;

/**
 * The transports, injectable so the checks are testable without a server —
 * and so a test can prove each FAIL line fires for exactly its own cause.
 */
export interface DoctorIo {
  fetchImpl: typeof fetch;
  /** Resolve on a completed websocket handshake; reject with a classified
   * CliError otherwise. The token is presented, never renewed. */
  dialWs(token: string): Promise<void>;
  now(): number;
  /** Threaded to the attend check's unit probe (`statusOf`, service.ts) so a
   * test never queries the real launchctl/systemd. Absent means the real
   * manager — which is the observation the check exists to make. */
  attendUnit?: ServiceIo;
}

function defaultIo(): DoctorIo {
  return {
    fetchImpl: (input, init) =>
      fetch(input, { ...init, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }),
    async dialWs(token: string): Promise<void> {
      const ws = new WsClient();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          // dialOnce, not connect: a probe must not arbitrate. connect()'s
          // refusal redial re-contests the account's routing row — three
          // dials and a second of sleeps that a probe loses BY DESIGN when a
          // healthy listener holds the socket — and on production that budget
          // outlived the race below, so time spent losing an arbitration was
          // reported as "no websocket handshake within 5000ms". One dial,
          // token presented as a plain string so nothing renews (the same
          // property the calls path relies on), is the whole observation.
          ws.dialOnce(token),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new CliError(
                    EXIT.NETWORK,
                    `no websocket handshake within ${PROBE_TIMEOUT_MS}ms`,
                  ),
                ),
              PROBE_TIMEOUT_MS,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
        ws.close();
      }
    },
    now: () => Date.now(),
  };
}

/** Group/other permission bits — anything here on a store is a finding. */
const WORLD_BITS = 0o077;

/**
 * WHERE DOCTOR'S HAND-PARSE OF profile.json WENT, and why its absence is the
 * fix rather than a tidy-up.
 *
 * A `StoredProfile` interface and an `existsSync` + `JSON.parse` stood here.
 * `loadProfile` was avoided because it THROWS on absence and doctor reports
 * rather than dying on the condition it exists to name — a true reason for a
 * false conclusion: it made this file a SECOND implementation of "is there a
 * profile", and the second implementation answered a different question from
 * the one every command and `cmdRegister` answer. Doctor asked whether the
 * PATH exists; registration asks whether the file LOADS. The two diverge on
 * exactly the state that matters — a file that is there and will not read —
 * and in that state doctor reported "no profile" and handed over the
 * register-now advice, which rewrote the profile without its `ownerUserId`
 *.
 *
 * `readProfile` (profile.ts) is the loader's own read with the three answers
 * kept apart — absent, unreadable, ok — and it never throws, so the reason the
 * hand-parse existed is gone with it. One read, one predicate, and it is the
 * predicate registration will use.
 */

function octal(mode: number): string {
  return `0${(mode & 0o777).toString(8)}`;
}

/**
 * A diagnostic that names the credential is not a diagnostic — it is a
 * disclosure with a diagnosis attached.
 *
 * `withheldIfCredential` used to stand here and suppress the whole detail when
 * `quotesCredential` said the runtime had quoted the bearer. It is gone, and
 * what replaced it is not a smaller version of it: the belt asked its question
 * at ONE sink on this file's ONE exception path, and the two disclosures the
 * review actually found were on the ordinary success path a few
 * dozen lines below — a `/v1/me` answering with the bearer as its `userId`,
 * printed whole through a 64-character field bound, and the same body sent as
 * non-JSON so that V8's `SyntaxError` quoted ten characters of it, which the
 * belt's sixteen-character probe could not see. Redaction now happens inside
 * `sanitizeServerField` for every registered credential, so every detail in
 * this file inherits it and the operator keeps the runtime's prose either way
 * (render.ts, THE CREDENTIAL CHOKEPOINT).
 */

/**
 * ---------------------------------------------------------------------------
 * WHAT `tacendum register <name>` WILL DO ON THIS MACHINE — asked once, of the
 * resolver that will actually decide it, and printed by everything that has an
 * opinion about it.
 *
 * WHY THIS IS HERE AND WHY IT IS ONE FUNCTION. The malformed-token refusal in
 * profile.ts has to choose between two remedies that differ in whether
 * FOLLOWING THEM DESTROYS THE ACCOUNT, and the question it turns on — "does an
 * identity credential for this account resolve here?" — is one the CLI already
 * answers operationally: `cmdRegister` asks `stores.identity.exists()`, which
 * is `identity.json` or `readCredential(name)` (keychain.ts), the module that
 * owns the marker, the backend order, the legacy coordinates and the
 * absent/failed distinction.
 *
 * The previous round answered it A SECOND TIME, by hand, in profile.ts: an
 * `existsSync` plus a hand-parse of `credential-backend.json`. THE SECOND
 * IMPLEMENTATION IS THE DEFECT, not any particular bug in it — two answers to
 * one operational question do not converge, they drift, and within one round
 * this one had drifted in BOTH directions at once:
 *
 *   - a marker naming a backend this build does not know read as "the key is
 *     somewhere I cannot look, therefore present". `recordedMarker` rejects
 *     the name and answers null, so on a file-preferred installation
 *     registration found NO credential and minted a replacement account —
 *     under a message promising a sign-in that keeps the owner binding.
 *   - a LOST marker beside a perfectly good keychain item read as "absent",
 *     and the message said "Do NOT register" about the one action that finds
 *     the item and signs in safely.
 *
 * So the probe is gone and the decision is made where the resolver can be
 * consulted. profile.ts cannot import keychain.ts (keychain imports profile,
 * for `profilePath`), and it should not want to: knowing what a credential IS
 * is that file's job; knowing where THIS machine's credential lives is
 * keychain.ts's, and reporting on it is this file's. `main.ts` attaches the
 * advice to `UnusableTokenError` at the single point every CLI failure is
 * printed. Nothing copies it.
 *
 * PRESENCE IS NOT CONTINUITY, and that is the second half. A credential that
 * resolves is only THIS account's credential if it is the same key:
 * `cmdRegister` authenticates whatever key it holds and declines to inherit
 * the class and the binding when the server answers with a different userId
 * (`previous?.userId === minted.userId`). A profile hand-copied beside
 * somebody else's valid identity.json therefore gets a valid key, a
 * successful registration, and a silent overwrite as an ordinary unbound
 * account. That comparison happens at the SERVER, so no local check can settle
 * it in advance — and the message therefore names the comparison and BOTH of
 * its outcomes rather than asserting one. Saying "it depends" would be a
 * hedge; saying "here is what is checked and here is what each answer costs
 * you" is an instruction.
 *
 * NO ACCOUNT NAME AND NO CREDENTIAL appears in any advice below — `<name>` is
 * a placeholder for the same reason every other remedy in this file uses one
 *, and the refusal in profile.ts has the same rule.
 * ---------------------------------------------------------------------------
 */
export type RegisterOutcome =
  /** A credential resolves and a profile records who this account is: register
   * presents that key, and the server decides whether it is the same account. */
  | 'sign-in'
  /** A credential resolves but there is no profile to compare against. */
  | 'adopt'
  /** No credential, but a profile says this machine once had the account:
   * registering MINTS A NEW ONE and strands the old. The destructive case. */
  | 'new-account'
  /** Nothing here at all — the ordinary first registration. */
  | 'first'
  /** The resolver refused to answer. Register will refuse for the same
   * reason; nothing about the outcome is knowable until it is fixed. */
  | 'unreadable'
  /**
   * The resolver ANSWERED, with a blob that is not a key this build can use.
   *
   * Distinct from 'unreadable' (nothing came back at all) and from 'sign-in'
   * (something came back and LOADS), and the distinction is the whole of gate
   * an earlier review: a non-null blob was read as a resolving credential,
   * so doctor printed an identity FAILURE and a session remedy promising that
   * registration would present that key — for bytes registration is about to
   * refuse with the same error. Its advice is the identity line's, because it
   * is the identity line's finding.
   */
  | 'credential-unusable'
  /**
   * A profile is on disk and would not READ. Register refuses rather than
   * writing over it (main.ts, `cmdRegister`), so this is not a variant of
   * 'new-account' — it is a different action with a different remedy, and the
   * thing at risk is the pairing metadata inside the file nobody can read.
   */
  | 'profile-unreadable';

export interface RegisterForecast {
  outcome: RegisterOutcome;
  /** One imperative paragraph, safe on stderr, in `--json`, and in a CI log. */
  advice: string;
}

/**
 * THE RECOVERY FOR A CREDENTIAL THAT IS PRESENT AND WILL NOT LOAD, phrased for
 * the copy commands actually read.
 *
 * "Restore identity.json from backup" is the whole answer on a file-backend
 * machine and is FALSE on one with a keychain backend recorded — not in some
 * exotic arrangement, but along a path the product walks by itself:
 *
 *   - the once-per-command migration hook (`requireAccount` in main.ts ->
 *     `maybeMigrateCredential` -> `migrateCredential`, keychain.ts) reads
 *     identity.json with `readFileSync`, hex-encodes it, and stores it. It
 *     never parses it, so a malformed credential migrates exactly as happily
 *     as a good one;
 *   - `recordBackend` then names the keychain, and `readCredential` step 1
 *     answers from the item and returns — the retained file is consulted only
 *     when the item is missing or will not decode, and a hex-clean copy of
 *     malformed JSON decodes perfectly;
 *   - so the restored file is never read again, by any command, and the
 *     operator follows correct-sounding advice to no effect whatsoever.
 *
 * The real repair is to put good bytes back into the ITEM, and there is exactly
 * one command that does it: `tacendum credential <name> --migrate`, which
 * `cmdCredential` runs with `force`, so it re-reads identity.json, stores it
 * over the item, and verifies the read-back before recording anything. (There
 * is no `--force` flag to type — the parser is strict and would reject it; the
 * command forces on its own.) WHAT IT DOES WHEN THE KEYCHAIN IS UNREACHABLE is
 * part of this paragraph's claim now, because the previous wording got it
 * wrong twice in one sentence: it said the command
 * "cannot run at all" in that state, when what the command actually did was
 * run, record backend `file` over the keychain marker, and exit 0 — a marker
 * flip that stopped every later read from consulting the item, permanently,
 * on a transient failure. The command now KEEPS the recorded backend in that
 * state (`kept-recorded`, keychain.ts) and exits with the keychain error, so
 * the paragraph below can promise — truthfully — that a failed attempt
 * records nothing and changes neither copy.
 *
 * ONE FUNCTION, TWO RENDERINGS, for this file's standing rule: the identity
 * line's remedy and the session forecast's advice are the same finding about
 * the same bytes, and a second copy of this sentence is how they come apart.
 *
 * `backend` IS THE MARKER'S RECORDED BACKEND — where a read is TRIED FIRST,
 * NOT where the bytes in the caller's hand came from. The two diverge along another path the product walks by itself: with a
 * keychain recorded and its lookup FAILING (a locked keyring, a dead session
 * bus, an item something else wrote over), `readCredential` does not refuse
 * while identity.json is retained — it falls through to the FILE (keychain.ts,
 * steps 1→2) and the file's bytes are what the caller validated. This sentence
 * used to assert the item unconditionally, which put
 *
 *     identity   FAIL … the unusable bytes are in the <backend> ITEM …
 *                       restoring the file ALONE changes nothing
 *     credential FAIL … the fallback file still covers reads
 *
 * in one report, about one set of bytes, saying opposite things — and the
 * operator who believes the first walks away from the malformed file that is
 * the actual repair.
 *
 * WHY IT IS NOT SIMPLY THREADED. `readCredential` answers `string | null`: it
 * carries no provenance, so the copy that answered is not knowable from its
 * result, and doctor must not go and ASK — a second lookup is a second read at
 * a second instant, which is the whole reason `forecastFrom` takes an
 * already-performed read rather than making its own. So the paragraph is
 * written to be true in BOTH states, prescribes the repair that covers both,
 * and sends the operator to the credential line — which DOES probe the item,
 * once, and reports what it found — to learn which state they are in.
 */
function unusableCredentialRecovery(backend: CredentialBackend): string {
  const cost =
    'THE KEY IS THE ACCOUNT, and a corrupt one cannot be regenerated without minting a NEW ' +
    'account — which would leave this one bound on the server and unreachable from here.';
  return backend === 'file'
    ? `Restore identity.json from backup; ${cost}`
    : `A ${backend} backend is recorded for this account, so reads go to the ITEM first and ` +
        'fall back to a retained identity.json when the item cannot be read — which of those ' +
        'two copies these unusable bytes came from is not knowable from here, and the ' +
        'credential line in this same report says which one your machine is in. THE REPAIR ' +
        'COVERS BOTH: restore identity.json from backup, then re-store it over the item with ' +
        'tacendum credential <name> --migrate (it re-reads the file, overwrites the item, and ' +
        'verifies the read-back before recording anything). Restoring the FILE alone is not ' +
        'enough while the item is readable, because that item is what every command answers ' +
        'from. While the keychain is unusable --migrate cannot complete: it exits with the ' +
        'keychain error and keeps the recorded backend — the FILE is never touched, and an ' +
        'item it stored but could not verify on read-back is removed rather than left ' +
        `half-written; retry once the keychain is reachable. ${cost}`;
}

/**
 * The forecast from an ALREADY-PERFORMED credential read, so a caller that has
 * one (runDoctor does) cannot produce a second, differently-timed answer. This
 * is what makes doctor's identity check and its session remedy incapable of
 * contradicting each other: they are two renderings of one read.
 *
 * `backend` is the resolution the caller ALREADY made (runDoctor's
 * `identityBackend`), passed in rather than re-derived for the same reason the
 * blob is: two reads of the marker at two instants are two answers.
 */
function forecastFrom(
  profile: ProfileRead,
  blob: string | null,
  refusal: CliError | null,
  backend: CredentialBackend,
): RegisterForecast {
  // A PROFILE THAT WILL NOT READ IS ANSWERED FIRST, ahead of the credential
  // question, because it settles the outcome on its own: `cmdRegister` refuses
  // to run at all in this state (main.ts), so what the identity credential
  // would have made of it never arises.
  //
  // This branch is a fix. Before it, the same state produced the
  // 'sign-in' advice — "run: tacendum register <name>" — and following that
  // advice is what DESTROYED the profile's `ownerUserId`: `tryLoadProfile`
  // answered null for a file it merely could not read, so registration
  // inherited nothing and rewrote an unbound account over a bound one. The
  // cost had been judged "one confusing sentence, not a
  // lost key". It was a lost binding, and the sentence caused it.
  if (profile.kind === 'unreadable') {
    return {
      outcome: 'profile-unreadable',
      advice:
        'do NOT register yet, and register will not let you: a profile for this account IS on ' +
        `disk and could not be read (${sanitizeServerField(profile.error.message, SERVER_DETAIL_MAX)}). ` +
        'That file is the only local record of what this account IS — its class, and the owner ' +
        'an integration is paired with — and a registration run over it would replace it with a ' +
        'record that has neither, on a machine where the server still holds the pairing. ' +
        'A FAILED READ IS NEVER EVIDENCE THAT THE PROFILE IS GONE. Make the file readable (a ' +
        'mode or an owner, usually) or restore it from backup, then re-run. If it is genuinely ' +
        'unrecoverable, MOVE IT ASIDE rather than deleting it — the account and its binding ' +
        'survive on the server, and the file is what a future you will want to read.',
    };
  }
  if (refusal !== null) {
    return {
      outcome: 'unreadable',
      advice:
        'do NOT register yet: the identity credential for this account could not be READ ' +
        `(${sanitizeServerField(refusal.message, SERVER_DETAIL_MAX)}), so what register would ` +
        'do is not knowable from here — and register will not guess either: it refuses with ' +
        'the same error rather than minting anything. A FAILED READ IS NEVER EVIDENCE THAT ' +
        'THE KEY IS GONE. ' +
        (refusal.exitCode === EXIT.AUTH
          ? 'Restore identity.json from backup; the key IS the account and cannot be re-minted.'
          : 'Unlock the keychain or restore the session bus, then re-run.'),
    };
  }
  // REGISTRATION'S OWN PREDICATE, not a pathname. `cmdRegister` decides what
  // it is looking at by whether the profile LOADS; asking `existsSync` here
  // made this forecast promise a userId comparison that registration would
  // never perform for a file it could not parse (carried limit 2, now gone —
  // the state it described is the branch above).
  const registered = profile.kind === 'ok';
  if (blob !== null) {
    // AND A BLOB IS NOT A CREDENTIAL. `identityLoads` — the SAME predicate the
    // identity line applies, which is the entire point of an earlier revision's fix — is
    // asked here too, because "did the read come back non-null" was a WEAKER
    // test than the one registration makes, and weaker in the direction that
    // promises the operator a sign-in they cannot have.
    //
    // What it cost: with `identity.json = {"identityKeyPair":"junk",
    // "registrationId":1}` doctor printed `FAIL identity — identity.json
    // exists but is unreadable` and, three lines below, `remedy: run:
    // tacendum register <name> — an identity credential for this account
    // resolves on this machine (the same read registration makes)`. It does
    // not resolve; `loadOrGenerateKeys` refuses those bytes and the command
    // exits nonzero. Two renderings of one read contradicting each other is
    // exactly what `forecastFrom` exists to make impossible, arriving through
    // the other predicate.
    //
    // ITS OWN OUTCOME rather than folding into 'unreadable': the resolver
    // answered, so the remedy is not "unlock the keychain" — it is the
    // identity line's, verbatim in substance, because the key IS the account
    // and a corrupt one cannot be regenerated.
    if (!identityLoads(blob)) {
      return {
        outcome: 'credential-unusable',
        advice:
          'do NOT register, and there is nothing registering could do: an identity credential ' +
          'for this account IS present and does not LOAD — the same read every command makes ' +
          '(identity.json, or the OS keychain when a backend is recorded for this account) came ' +
          'back with bytes this build cannot use as a key, which is what the identity check ' +
          'reports. Register refuses those bytes for the same reason rather than minting over ' +
          `them, so this is not a state a re-registration gets you out of. ${unusableCredentialRecovery(backend)} ` +
          'If the key is genuinely gone the account cannot be recovered, and a replacement has ' +
          'to be registered and paired again.',
      };
    }
    return registered
      ? {
          outcome: 'sign-in',
          advice:
            'run: tacendum register <name> — an identity credential for this account resolves ' +
            'on this machine (the same read registration makes), so register presents that key ' +
            'instead of generating one. WHICH ACCOUNT THAT IS, IS SETTLED AT THE SERVER: ' +
            'register compares the user id the key authenticates as against the one this ' +
            'profile records. If they MATCH, this is a sign-in — the account keeps its class ' +
            'and its owner binding, and only the token is replaced. If they DIFFER, the key ' +
            'here belongs to a different account: this profile is overwritten as that one, and ' +
            'the account it named stays bound on the server and unreachable from this machine. ' +
            'Confirm which happened with: tacendum whoami <name>.',
        }
      : {
          outcome: 'adopt',
          advice:
            'run: tacendum register <name> — an identity credential resolves on this machine ' +
            'but there is no profile beside it, so there is nothing here to compare the result ' +
            'against: this name will hold whatever account that key belongs to. Check it with: ' +
            'tacendum whoami <name>.',
        };
  }
  return registered
    ? {
        outcome: 'new-account',
        advice:
          'do NOT register yet: no identity credential for this account resolves on this ' +
          'machine — registration reads it exactly the way every command does (identity.json, ' +
          'or the OS keychain when a backend is recorded for this account), and that read came ' +
          'back empty, while a profile says this machine did once hold the account. The key IS ' +
          'the account, so registering would MINT A NEW ACCOUNT: a new user id, an ordinary ' +
          'account class, no owner binding — and the existing account stays bound on the ' +
          'server, unreachable from here. Restore identity.json from backup first, then run: ' +
          'tacendum register <name>. If the key is genuinely gone the account cannot be ' +
          'recovered, and a replacement has to be registered and paired again.',
      }
    : {
        outcome: 'first',
        advice:
          'run: tacendum register <name> — nothing is registered for this account on this ' +
          'machine (no profile, and no identity credential resolves), so this CREATES the ' +
          'account rather than signing anything in.',
      };
}

/**
 * The forecast for a caller with no read of its own — `main.ts`'s failure
 * path. Read-only, like every probe in this file: `readCredential`'s keychain
 * lookups never store and never rewrite a marker.
 */
export function registerForecast(name: string): RegisterForecast {
  let blob: string | null = null;
  let refusal: CliError | null = null;
  try {
    blob = readCredential(name);
  } catch (err) {
    // Anything at all — a keychain refusal, an illegal name, a broken tool —
    // is "the question was not answered", which is its own honest outcome.
    // Composing a remedy must never be the thing that throws.
    refusal = err instanceof CliError ? err : new CliError(EXIT.ERROR, 'unreadable');
  }
  // Which copy the read above would have come from. Guarded for this
  // function's rule — composing a remedy must never throw — and 'file' is the
  // right fallback when the marker cannot be read at all: it is the shipping
  // state, and its advice names the file the operator has in front of them.
  let backend: CredentialBackend = 'file';
  try {
    backend = credentialStatus(name).backend;
  } catch {
    // Nothing to say about it here; the refusal above already carries the
    // cause the operator needs.
  }
  // `readProfile` does not throw either, for the same reason.
  return forecastFrom(readProfile(name), blob, refusal, backend);
}

/**
 * WILL AN OPERATIONAL READ ACCEPT THIS CREDENTIAL? — the whole of what a PASS
 * on the identity line is allowed to mean.
 *
 * This used to be `typeof identityKeyPair === 'string' && length > 0`, which
 * is a WEAKER test than the one every command makes, and weaker in the
 * direction that produces a false green. `FileIdentityKeyStore.parseCredential`
 * (stores.ts) additionally requires a numeric `registrationId`, and every
 * operational read of the key — `getIdentityKey`, `getLocalRegistrationId`,
 * `getPublicIdentityKey`, and therefore every send, listen and safety number —
 * goes on to `IdentityKeyPair.deserialize` the base64 it found.
 *
 * So `identity.json = {"identityKeyPair":"junk"}` produced an ENTIRELY GREEN
 * doctor — identity, profile, network, all PASS — on a machine where the next
 * command refuses with "the stored credential is not in the format this CLI
 * writes". That is a FALSE DIAGNOSTIC, not a wrong remedy printed after a
 * correct refusal, and the earlier judgment that called it the latter was wrong about
 * which of the two predicates was which.
 *
 * MIRRORED, NOT IMPORTED, and the duplication is deliberate rather than
 * unavoidable. `FileIdentityKeyStore`'s constructor `mkdirSync`s the peer
 * directory, and doctor observes without repairing — constructing one to ask a
 * question would create the store it is reporting on, which is the same
 * mistake the `existsSync`-not-`FileStores` rule at the top of this file
 * exists to prevent. What keeps the two from drifting is not care: it is
 * `test/gate.doctor-identity-conformance.test.ts`, which drives a corpus of
 * blobs through THIS function and through a real `FileIdentityKeyStore`,
 * requires the two verdicts to AGREE, and requires each verdict to be the
 * EXPECTED one — agreement alone does not give that, because two predicates
 * tightened the same way agree perfectly and are both wrong.
 *
 * WHAT THAT CORPUS ACTUALLY PINS, stated exactly, because the sentence here
 * used to be "so a change to either side goes red" and no finite corpus can
 * make that true. It is spread over the dimensions a divergence shows up in:
 * REAL keys across the registration-id range (0, 1, 42, 100, 101, 16383,
 * 4242 — 0 because it is a number and falsy, 16383 because it is the top of
 * libsignal's 14-bit space), real keys with each wrong registrationId TYPE
 * (null, boolean, a numeric string, absent), a real key with a registrationId
 * of the right type and a REFUSED VALUE (42.5), real shapes with the key BYTES
 * corrupted (truncated, and valid base64 of something that is not a key), and
 * the document-level shapes. A change to either side that alters its verdict
 * on any of those goes red.
 *
 * It had exactly ONE credential both sides accepted — a real key with
 * `registrationId: 4242` — so tightening either side to `registrationId >
 * 100` left the whole file green while every real account below that
 * threshold diverged. That mutation now turns FIVE
 * cases red on this side and SIX on the store side, measured by running it
 * one side at a time. What is still NOT caught is a divergence that agrees on
 * every case in the corpus — a range check above 16383, say. This is a
 * spread, not a proof.
 *
 * AND A CORPUS CAN PIN THE WRONG THING, which is the other half of an earlier revision
 * an earlier finding. `registrationId: 42.5` sat under a label beginning "a real
 * credential", so the corpus REQUIRED both sides to accept it — while
 * packages/shared declares `int().nonnegative()` and libsignal refuses the
 * value at the u32 boundary. Both predicates agreed, and the agreement was
 * wrong: a correct integer check on either side turned the corpus red. It was
 * decided in the product rather than in the test (`Number.isInteger`, here and
 * in `parseCredential`), and the case is MUST_REFUSE now.
 *
 * The caught errors are DISCARDED — never rethrown, never interpolated. A
 * libsignal deserialize failure and a V8 SyntaxError both quote their input,
 * and their input is the account's private key (stores.ts states this rule at
 * the same parse, about the same bytes).
 */
function identityLoads(blob: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(blob);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const record = parsed as { identityKeyPair?: unknown; registrationId?: unknown };
  // AN INTEGER, not merely a number — mirroring the store exactly, including
  // the absence of a range check. `parseCredential` (stores.ts) carries the
  // argument and the evidence at the same three lines; a divergence between
  // these two spellings is what `gate.doctor-identity-conformance.test.ts`
  // exists to turn red.
  if (
    typeof record.identityKeyPair !== 'string' ||
    typeof record.registrationId !== 'number' ||
    !Number.isInteger(record.registrationId)
  ) {
    return false;
  }
  try {
    IdentityKeyPair.deserialize(b64ToBytes(record.identityKeyPair));
  } catch {
    return false;
  }
  return true;
}

export async function runDoctor(name: string, io: DoctorIo = defaultIo()): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const home = tacendumHome();
  const dir = clientDir(name); // throws on an illegal name, same as every command

  // WHETHER THE NAME MAY BE ECHOED, decided once, here.
  //
  // Every remedy below wants to say `tacendum register <that name>`, and for a
  // REAL account that is both safe and the useful half of the message. For an
  // argument nobody has validated it is a leak — a misconfigured variable
  // (`tacendum doctor "$SECRET"`) put the secret in a FAIL line and from there
  // into hook and CI logs.
  //
  // Doctor must still DIAGNOSE an account whose store is broken — that is what
  // it is for, so refusing outright was the wrong instinct. It reports exactly
  // as before; only the name-shaped half of each remedy degrades to a
  // placeholder when the account is not one we know.
  //
  // THE NAME IS NEVER ECHOED, and the reasoning that led here is worth keeping
  // because two cleverer rules were tried first and both leaked.
  //
  // An earlier revision used directory existence. Wrong: `FileStores`' constructor mkdirs
  // before any network call, so a failed `register "$SECRET"` left the
  // directory and the test then vouched for the secret it was meant to
  // suppress. An earlier revision used a completed profile.json, reasoning that the file
  // is written only after `POST /v1/auth` succeeds. Also wrong, and wrong more
  // deeply: cmdRegister saves the profile BEFORE `PUT /v1/keys`, so a
  // registration that failed at the upload still leaves one — but the real
  // defect is the premise. THE LOCAL CLIENT NAME IS CHOSEN BY THE CALLER AND
  // NEVER SENT ANYWHERE. The server has no opinion about it, so no server
  // interaction can ever certify it, and every predicate of the form "the
  // account is real, therefore the string is safe" is answering a different
  // question than the one that matters.
  //
  // So there is nothing left to condition on, and the placeholder is
  // unconditional. It costs a copy-pasteable path in the remedies; the person
  // reading them typed the name one line earlier and can substitute it.
  const profilePath = join(dir, 'profile.json');
  const shown = '<name>';
  /** A path with the account segment replaced. The directory is built FROM the
   * argument, so printing it verbatim leaks the argument as surely as quoting
   * it does. */
  const shownPath = (p: string): string => p.split(name).join('<name>');

  // THE PROFILE, READ ONCE, THE WAY THE LOADER READS IT. Used by the register
  // forecast below (which must predict what registration will do, and
  // registration asks whether the file LOADS) and by the session check (which
  // must tell "there is no profile" from "there is one and it will not read").
  // `readProfile` never throws, and `loadProfile` inside it registers the
  // credential with the chokepoint at the moment the bytes become a value —
  // which is why nothing in this file hand-parses profile.json any more.
  const profileRead = readProfile(name);

  // --- home: the store exists and only its owner can read it -----------------
  if (!existsSync(home)) {
    results.push({
      check: 'home',
      ok: false,
      detail: `TACENDUM_HOME does not exist (${home})`,
      remedy: `run: tacendum register ${shown} (it creates the store) — or point TACENDUM_HOME at the right place`,
    });
  } else {
    const loose: string[] = [];
    // The key compartment AND the chat-state compartment: they are separated
    // on purpose (see stateDir in config.ts), which means there are two
    // directories that can silently go world-readable, not one.
    for (const path of [home, dir, stateDir(name)]) {
      if (!existsSync(path)) continue;
      const mode = statSync(path).mode;
      if ((mode & WORLD_BITS) !== 0) loose.push(`${shownPath(path)} is ${octal(mode)}`);
    }
    if (loose.length > 0) {
      results.push({
        check: 'home',
        ok: false,
        detail: `store readable beyond its owner: ${loose.join(', ')}`,
        remedy: `run: chmod 700 ${loose.length > 1 ? `${home} ${shownPath(dir)}` : loose[0]?.split(' ')[0] ?? shownPath(dir)} — the identity key and the message log live here`,
      });
    } else {
      results.push({
        check: 'home',
        ok: true,
        // shownPath here too: the PASS line is output like any other, and the
        // directory exists for a name that merely FAILED to register (the
        // constructor-mkdir above), so "it exists" proves nothing about it
        // being safe to print.
        detail: `${existsSync(dir) ? shownPath(dir) : home} exists, owner-only permissions`,
      });
    }
  }

  // --- identity: the key that IS the account ---------------------------------
  // Resolved EXACTLY the way commands resolve it — always through
  // `readCredential` (`FileIdentityKeyStore.load` routes there, stores.ts):
  // the marker decides whether the OS keychain item or the retained file
  // answers, and doctor must validate THAT blob, not whichever copy is handy.
  // The previous shape — read identity.json directly whenever it existed —
  // was a bug: the keychain item and the file CAN hold
  // different identities (a shared pre-scoping coordinate overwritten by a
  // same-named account in another TACENDUM_HOME, a restored backup), and in
  // that state doctor vouched for the file while every command used the item:
  // identity PASS for an identity no command was using. The credential check
  // below is the line that compares the two copies and FAILS loudly when they
  // disagree; this one validates the copy that commands answer with.
  // A migrated-and-file-removed account is HEALTHY, and a doctor reading only
  // identity.json would FAIL it — a false line that sends the operator to
  // "restore from backup" a file that is gone on purpose. `readCredential` is
  // read-only (its probes are lookups; it never stores or rewrites a marker),
  // so "doctor observes" holds; its refusal on an unreachable-but-evidenced
  // keychain is caught into a FAIL line, because a check that cannot run must
  // say why, not kill the report.
  const identityPath = join(dir, 'identity.json');
  const identityOnDisk = existsSync(identityPath);
  // Where reads for this account are TRIED FIRST (marker-decided) — used only
  // to phrase the lines below truthfully; `credentialStatus` is read-only.
  // NOT the copy the read below answered from: a recorded keychain whose
  // lookup fails falls through to a retained identity.json, so the two can
  // differ, and every line phrased from this value has to stay true either way
  // (an earlier review — see `unusableCredentialRecovery`).
  const identityBackend = credentialStatus(name).backend;
  let identityBlob: string | null = null;
  let identityRefusal: CliError | null = null;
  try {
    identityBlob = readCredential(name);
  } catch (err) {
    identityRefusal = err instanceof CliError ? err : new CliError(EXIT.ERROR, 'unreadable');
  }
  // ONE READ, TWO RENDERINGS. Every line below that wants to say "run
  // register" asks this, and it is derived from the very `readCredential` the
  // identity check just made — so the identity finding and the session remedy
  // are incapable of contradicting each other. They did: with a bound profile
  // and a missing identity, `identity` said "restore from backup, the key
  // cannot be re-minted" while `session` said "run register, it signs in
  // rather than creating anything", and following the second is what strands
  // the account the first was trying to save.
  const forecast = forecastFrom(profileRead, identityBlob, identityRefusal, identityBackend);
  if (identityRefusal !== null) {
    results.push({
      check: 'identity',
      ok: false,
      // THE CAUSE, NAMED ON THE LINE THAT HOLDS IT. This used to say "the
      // credential check names the cause" — a PROMISE about another line,
      // and in the ordinary no-item state that line reached its generic
      // PASS having never opened the file, so nothing in the report named
      // the file permission. The refusal this arm
      // already caught carries its own cause in prose crafted for exactly
      // this surface: `readCredential`'s CliErrors are path-free by
      // construction (fixed wording plus a shape-checked errno or a
      // classified tool failure — keychain.ts), the same property the
      // credential catch below stands on when it prints `err.message`. The
      // non-CliError wrap above reduces to the fixed word 'unreadable'.
      detail: `the identity could not be read — ${identityRefusal.message}`,
      remedy:
        identityRefusal.exitCode === EXIT.AUTH
          ? 'restore identity.json from backup; the key IS the account and cannot be re-minted'
          : 'unlock the keychain / restore the session bus, then retry',
    });
  } else if (identityBlob === null) {
    results.push({
      check: 'identity',
      ok: false,
      detail: `no identity key (${shownPath(identityPath)})`,
      remedy:
        `if this client was ever registered, restore identity.json from backup — the key IS the ` +
        `account and cannot be re-minted. For a NEW account: tacendum register ${shown}`,
    });
  } else {
    const readable = identityLoads(identityBlob);
    results.push(
      readable
        ? {
            check: 'identity',
            ok: true,
            // Phrased from the marker, not from which file happens to exist:
            // with a keychain backend recorded, commands answer keychain-first
            // even while identity.json is retained as the fallback.
            detail:
              identityBackend === 'file'
                ? 'identity key present'
                : identityOnDisk
                  ? 'identity key present (keychain-first; identity.json retained as fallback)'
                  : 'identity key present (held in the OS keychain)',
          }
        : {
            check: 'identity',
            ok: false,
            // The blob came from wherever commands read (readCredential), so
            // the FAIL must not blame identity.json when the unparseable copy
            // is the keychain item commands are actually using.
            detail:
              identityBackend === 'file'
                ? `identity.json exists but is unreadable (${shownPath(identityPath)})`
                : 'the credential commands read does not parse as an identity key',
            // The SAME sentence the session forecast prints for the same bytes,
            // from the same function — this line used to say "restore
            // identity.json from backup" unconditionally, which is false of the
            // very state its own detail line describes.
            remedy: unusableCredentialRecovery(identityBackend),
          },
    );
  }

  // --- credential: where that key actually lives ------------------------------
  // The whole check lives in keychain.ts (`credentialCheck`) next to the
  // backend rules it reports on; read-only by construction, like every line
  // in this file. CAUGHT like the identity read above it, and for the same
  // doctrine — a check that cannot run must say why, not kill the report:
  // uncaught, an unreadable identity.json threw a raw
  // fs error through this push and doctor died with ZERO checks printed and
  // the full unmasked path — account segment included — on stderr. The
  // reads inside credentialCheck are guarded now; this catch is the
  // doctrine's own backstop, and it prints no foreign message: a CliError's
  // prose is sanitized by construction (keychain.ts), anything else is
  // reduced to a shape-checked errno.
  try {
    results.push(credentialCheck(name));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    const errno =
      typeof code === 'string' && /^E[A-Z0-9]{1,16}$/.test(code) ? code : 'unclassified';
    results.push({
      check: 'credential',
      ok: false,
      detail:
        err instanceof CliError
          ? `the credential check could not run — ${err.message}`
          : `the credential check could not run (${errno})`,
      remedy:
        'fix what the detail names (keychain reachability, file permissions), then ' +
        're-run doctor',
    });
  }

  // --- attend: the answerer, when this machine was asked to have one ---------
  // ONE reader — `attendState` (attend.ts) — and doctor re-derives NOTHING
  // from attend's files. This file's history is a list of second
  // implementations that contradicted the first (the profile hand-parse, the
  // weaker identity predicate, the by-hand register probe), and each drifted
  // from the answer the product actually acts on; the attend facts stay with
  // the code attend's own commands read them through. `attendState` is a pure
  // reader — no lock, no markRead, no turn token — so "doctor observes" holds.
  //
  // "NOT ENABLED" IS A PASS, AND SO IS "DISABLED". main.ts maps any FAIL to a
  // non-zero exit, and doctor is what provisioning scripts gate on — failing
  // an account that never opted in would turn every provisioning run red on
  // machines that never wanted attend, for a feature that is off by default
  // on purpose. FAIL is reserved for states where the
  // operator ASKED for an answerer and has a broken one:
  //   - a config that does not load: `loadAttendConfig` reads that as
  //     "disabled", so the agent silently stops answering and nothing else
  //     in the product will ever say why;
  //   - `bin` no longer an executable file — the same test `attend enable`
  //     made, re-asked, because an nvm bump moves the path after enable and
  //     the operator currently learns at turn time, as an exit-127 report to
  //     their phone;
  //   - a workdir that is not a directory;
  //   - unpaired: `attendOnce` refuses to run at all;
  //   - a unit installed but not running — supervision that is not
  //     supervising (not-installed stays a PASS: hand-run loops are legal).
  {
    const attend = attendState(name, {
      now: () => io.now(),
      ...(io.attendUnit === undefined ? {} : { service: io.attendUnit }),
    });
    if (attend.state === 'absent' || attend.state === 'disabled') {
      results.push({
        check: 'attend',
        ok: true,
        detail:
          attend.state === 'absent'
            ? 'not enabled — attend is opt-in, and nothing executes'
            : 'disabled — messages queue for reading, nothing executes',
      });
    } else if (attend.state === 'unparseable') {
      results.push({
        check: 'attend',
        ok: false,
        detail:
          'attend.json exists and does not load — attend reads that as "disabled" and answers ' +
          'nothing, but nobody chose it: a clean disable writes an EMPTY file, not a corrupt one',
        remedy:
          `re-enable: tacendum attend enable ${shown} — or disable cleanly: ` +
          `tacendum attend disable ${shown}`,
      });
    } else {
      const faults: string[] = [];
      const remedies: string[] = [];
      if (!attend.paired) {
        faults.push('no pairing — attend refuses to run without an owner binding');
        remedies.push(`pair it: tacendum pair ${shown} <owner-id>`);
      }
      if (!attend.binRunnable) {
        faults.push(
          'the agent binary is no longer an executable file (an upgrade that moved the ' +
            'path, usually) — every turn fails as an exit-127 report to the phone',
        );
        remedies.push(`re-resolve it: tacendum attend enable ${shown} --bin <path-to-agent>`);
      }
      if (!attend.workdirIsDirectory) {
        faults.push('the workdir is not a directory — turns cannot run there');
        remedies.push(`re-point it: tacendum attend enable ${shown} --workdir <dir>`);
      }
      if (attend.unit.installed && !attend.unit.running) {
        faults.push('the attend unit is installed but NOT running');
        remedies.push(
          `check the unit's stderr log, then reinstall: tacendum attend service install ${shown}`,
        );
      }
      // AN APPROVAL PENDING PAST ITS OWN DEADLINE IS A CONTRADICTION, not a
      // wait: a parked pass denies at the TTL, and a pass that
      // died is swept to `lapsed` by the next pass's restart rule — so a row
      // still awaiting an answer past its deadline means NO pass has run
      // since, whatever the unit table says. `attendState` derives the count
      // (doctor re-derives nothing — this file's standing rule); the grace
      // and the answering-rows exclusion are argued there, once.
      if (attend.approvalsPendingPastTtl > 0) {
        faults.push(
          `${attend.approvalsPendingPastTtl} approval${
            attend.approvalsPendingPastTtl === 1 ? '' : 's'
          } still pending past ${
            attend.approvalsPendingPastTtl === 1 ? 'its' : 'their'
          } own deadline — a running pass would have expired ${
            attend.approvalsPendingPastTtl === 1 ? 'it' : 'them'
          }, so the answerer is not running`,
        );
        remedies.push(
          `restart the answerer (the sweep will settle the stale card honestly): ` +
            `tacendum attend service install ${shown} — or run a pass by hand: ` +
            `tacendum attend run ${shown}`,
        );
      }
      // Counts and states only: no path (the config's paths embed
      // the operator's tree), no session id, no message text. The approval
      // journal joins as counts alone — never a payload.
      const summary =
        `attend enabled (${attend.host}) — ` +
        `${
          !attend.unit.installed
            ? 'unit not installed'
            : attend.unit.running
              ? 'unit running'
              : 'unit installed, NOT running'
        }, ${attend.turnsUsed} of ${attend.turnsPerHour} turns used this hour, ` +
        `approvals: ${attend.approvalsPending} pending / ${attend.approvalsSettled} settled, ` +
        `${attend.approvalOverCapRefusals} over-cap refusal${
          attend.approvalOverCapRefusals === 1 ? '' : 's'
        }`;
      results.push(
        faults.length === 0
          ? { check: 'attend', ok: true, detail: summary }
          : {
              check: 'attend',
              ok: false,
              detail: `${summary}; ${faults.join('; ')}`,
              remedy: remedies.join(' — and ')
            },
      );
    }
  }

  // --- api + clock: one round trip answers both ------------------------------
  // /health is unauthenticated on purpose — reachability must be checkable
  // with dead credentials, or this check could never outlive the session one.
  let health: Response | null = null;
  let probeStart = 0;
  let probeEnd = 0;
  let apiFailure = '';
  try {
    probeStart = io.now();
    health = await io.fetchImpl(`${API_BASE}/health`);
    probeEnd = io.now();
  } catch (err) {
    // A transport error's message is the runtime's prose around OUR endpoint
    // and, on a redirect or a proxy fault, bytes that came off the wire. It is
    // headed for a FAIL line, so it crosses the field sanitizer here, where it
    // enters the finding.
    apiFailure = sanitizeServerField(
      err instanceof Error ? err.message : 'network error',
      SERVER_DETAIL_MAX,
    );
  }
  if (health) {
    // ANY answer proves reachability, which is this check's whole question —
    // the server spoke. A 404 means only that this deployment predates the
    // /health route, and reporting that as a failed api check taught the
    // operator to distrust a diagnostic that was telling the truth about the
    // network (found live in production: session and websocket
    // both passed while `api` cried wolf).
    //
    // But the KIND of answer is not one fact, and the earlier phrasing
    // explained every non-2xx as "no health route" — false for exactly the
    // two answers that are urgent. A 5xx is the opposite of a missing route:
    // the route exists and the service behind it is answering unwell. A 429
    // means even this unauthenticated probe is being throttled, so the
    // checks after it are suspect too. Each gets its own sentence; the line
    // still PASSES, because reachability is still the question and the
    // service's health shows up where it belongs (session, and the server's
    // own logs).
    const answered = `${API_BASE} answered in ${probeEnd - probeStart}ms`;
    results.push({
      check: 'api',
      ok: true,
      detail: health.ok
        ? `${API_BASE}/health answered in ${probeEnd - probeStart}ms`
        : health.status >= 500
          ? `${answered} (HTTP ${health.status} from /health — reachable, and the route ` +
            'exists: the service behind it is answering errors. The server is unwell; ' +
            'check its logs)'
          : health.status === 429
            ? `${answered} (HTTP 429 from /health — reachable, but rate limited: even this ` +
              'unauthenticated probe was throttled, so later checks may be too. Wait, then ' +
              're-run)'
            : health.status === 404
              ? `${answered} (HTTP 404 from /health — reachable; this deployment has no ` +
                'health route)'
              : `${answered} (HTTP ${health.status} from /health — reachable; an unexpected ` +
                'answer for a health route, worth a look at whatever fronts the API)',
    });
  } else {
    results.push({
      check: 'api',
      ok: false,
      detail: `${API_BASE} is unreachable (${apiFailure})`,
      remedy: `check the network path and TACENDUM_API (current: ${API_BASE})`,
    });
  }

  // Clock skew from the Date header of the same response. One-second header
  // granularity and the request's own latency both disappear inside a 30s
  // tolerance; centring on the probe midpoint keeps the estimate honest.
  if (!health) {
    results.push({
      check: 'clock',
      ok: false,
      detail: 'could not measure — the API is unreachable',
      remedy: 'fix the api check first; skew is measured against its response',
    });
  } else {
    const dateHeader = health.headers.get('date');
    const serverMs = dateHeader ? Date.parse(dateHeader) : NaN;
    if (!Number.isFinite(serverMs)) {
      results.push({
        check: 'clock',
        ok: false,
        detail: 'the server sent no usable Date header — skew unknown',
        remedy: 'verify TACENDUM_API points at a Tacendum server, not a proxy that strips headers',
      });
    } else {
      // +500ms: the header truncates to the second, so its true value is the
      // centre of the second it names.
      const skewMs = Math.round(serverMs + 500 - (probeStart + probeEnd) / 2);
      const within = Math.abs(skewMs) <= CLOCK_SKEW_TOLERANCE_MS;
      results.push(
        within
          ? { check: 'clock', ok: true, detail: `skew ${skewMs}ms (tolerance ${CLOCK_SKEW_TOLERANCE_MS}ms)` }
          : {
              check: 'clock',
              ok: false,
              detail: `local clock is ${Math.abs(skewMs)}ms ${skewMs > 0 ? 'behind' : 'ahead of'} the server (tolerance ${CLOCK_SKEW_TOLERANCE_MS}ms)`,
              remedy:
                'fix the system clock (enable NTP). Auth challenges live 120s; a drifted clock ' +
                'turns every sign-in into an unexplained 401',
            },
      );
    }
  }

  // --- session: the token, presented raw so nothing can renew it mid-check ---
  const record = profileRead.kind === 'ok' ? profileRead.profile : null;
  // Still `typeof`-guarded: the record came off disk as untrusted JSON, and
  // `Profile` types `authToken` as a string because that is what WE write, not
  // because anything checked it.
  const token = typeof record?.authToken === 'string' ? record.authToken : '';
  /**
   * Can this token be put in a header at all — decided by `loadProfile`, on
   * the read above, rather than re-derived here.
   *
   * This file used to answer it with its own `isHeaderSafeToken` call over its
   * own hand-parse, because doctor REPORTS and `loadProfile` throws. Both
   * halves are now handled where they belong: `readProfile` turns the throw
   * into an answer, and `UnusableTokenError` carries the account's record with
   * the credential EMPTIED — so on this branch there is no token in this
   * process to present, which is a stronger property than remembering not to
   * present it.
   *
   * It was presented twice before the split existed: the `/v1/me` probe below
   * and the ws dial further down both handed it to Node's header validator,
   * which reports an invalid value by QUOTING it, and both printed that as a
   * FAIL detail with a remedy sending the operator to hunt a network fault. So
   * `doctor` disclosed the credential in the one command an operator runs when
   * they already suspect something is wrong, and told them to check their
   * firewall.
   */
  const tokenUsable = token !== '';
  if (profileRead.kind === 'unreadable') {
    // A FILE THAT WILL NOT READ IS NOT AN ABSENT ACCOUNT, and reporting it as
    // one is how this command became half of a data-loss path: "no profile"
    // plus the register-now remedy is an instruction to overwrite the file
    // nobody could read, and the pairing metadata inside it. The refusal's own prose is carried — it is this codebase's,
    // never the runtime's, and it names neither the path nor the account.
    results.push({
      check: 'session',
      ok: false,
      detail:
        `a profile exists and could not be READ (${shownPath(profilePath)}): ` +
        sanitizeServerField(profileRead.error.message, SERVER_DETAIL_MAX),
      remedy: forecast.advice,
    });
  } else if (profileRead.kind === 'ok' && !profileRead.tokenUsable) {
    // AHEAD OF THE "no token" BRANCH, and the order is load-bearing.
    // `UnusableTokenError` carries the record with the credential EMPTIED, so
    // by the time it reaches this function a malformed token and an absent one
    // look identical — and asking `!token` first reported "profile.json has no
    // auth token" for a profile that has a perfectly present token this client
    // cannot send. Two different faults with two different remedies, and the
    // wrong one is the one that says nothing about the older build that wrote
    // it.
    //
    // NAMED, NOT QUOTED. The operator needs to know which of the two token
    // failures they have — "the server refused it" and "this client cannot
    // send it" have completely different remedies — and needs none of the
    // bytes to know it.
    results.push({
      check: 'session',
      ok: false,
      detail:
        'the stored token cannot be presented as an HTTP header, so it was never sent — it ' +
        'was written by an older build that did not check the value (not echoed here: it is ' +
        'a credential)',
      // The same string profile.ts's refusal carries, from the same read — so
      // `doctor` and the refusal an operator hits on any other command cannot
      // give different advice about the same machine.
      remedy: forecast.advice,
    });
  } else if (!token) {
    results.push({
      check: 'session',
      ok: false,
      detail:
        record !== null
          ? // shownPath is the identity function on this branch — the path is
            // built from the argument either way, so it is wrapped anyway and a
            // future change to the predicate cannot quietly reopen the echo.
            `profile.json has no auth token (${shownPath(profilePath)})`
          : `no profile (${shownPath(profilePath)})`,
      // THE ONE FORECAST, not a sentence of its own. This line used to assert
      // "with the identity key on disk this signs in rather than creating
      // anything" unconditionally — including on a machine with no identity
      // key at all, where it is the instruction that mints a replacement
      // account over a bound one.
      remedy: forecast.advice,
    });
  } else if (!health) {
    results.push({
      check: 'session',
      ok: false,
      detail: 'token present, but it could not be checked — the API is unreachable',
      remedy: 'fix the api check first; the token is validated against /v1/me',
    });
  } else {
    try {
      const me = await io.fetchImpl(`${API_BASE}/v1/me`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (me.ok) {
        const body = (await me.json()) as { userId?: unknown };
        const stored = typeof record?.userId === 'string' ? record.userId : '';
        if (stored && body.userId === stored) {
          results.push({ check: 'session', ok: true, detail: 'token accepted by the server' });
        } else {
          results.push({
            check: 'session',
            ok: false,
            // `/v1/me`'s body is read as `{ userId?: unknown }` and shape-
            // checked nowhere, so this is whatever the server said. It is the
            // sink an earlier review reproduced a forged `PASS session` line
            // through.
            //
            // BOTH IDS, not just the live one. `stored` looks local — it is
            // read out of this machine's profile.json — but `AuthResponse`
            // types `userId` as a plain `z.string()` and `cmdRegister` saves
            // it verbatim, so it is SERVER text that has been laundered
            // through a file. The comparison above stays byte-exact; only the
            // display is treated as a field, which is the same split
            // render.ts's mention branch makes for hand-editable peer names.
            detail: `the token resolves to ${sanitizeServerField(String(body.userId))} but the profile says ${stored ? sanitizeServerField(stored) : '(missing)'}`,
            remedy:
              'the stored profile and the live session disagree — do not send until this is ' +
              `understood. Compare with: tacendum whoami ${shown}`,
          });
        }
      } else if (me.status === 401 || me.status === 403) {
        results.push({
          check: 'session',
          ok: false,
          detail: `the server refused the token (HTTP ${me.status}) — expired or revoked`,
          // The automatic path first, because it is the one that costs
          // nothing; the explicit one is the forecast, because "or explicitly:
          // tacendum register <name>" was the same unconditional promise in a
          // shorter sentence, and this is the check most likely to be read on
          // a machine whose identity is the thing that went missing.
          remedy:
            'any send or listen renews it automatically from the identity key; ' +
            `or explicitly — ${forecast.advice}`,
        });
      } else {
        results.push({
          check: 'session',
          ok: false,
          detail: `unexpected HTTP ${me.status} from /v1/me`,
          remedy: 'the API answered but not about the token; check the server logs',
        });
      }
    } catch (err) {
      results.push({
        check: 'session',
        ok: false,
        // The ERROR path is a server sink too, and it is the one that reads
        // like ours rather than like theirs. `me.json()` on a 2xx body that is
        // not JSON raises a V8 SyntaxError whose message QUOTES the server's
        // own bytes back — `Unexpected token '<ESC>', "<ESC>[2K<FS>PASS …"` —
        // so the forgery arrives inside a message this file composed.
        //
        // AND IT IS A CREDENTIAL SINK, twice over. Node's header rejection
        // arrives here quoting the bearer whole; and a `/v1/me` whose 200 body
        // IS the bearer arrives here as V8's `Unexpected token 'Z',
        // "Zq3Rk8Xv1T"... is not valid JSON` — TEN characters of the live
        // token, which is exactly the disclosure a sixteen-character probe
        // reported as clean. Neither is a matter of shape, so neither is fixed
        // by a sanitizer that only strips control bytes: `sanitizeServerField`
        // now REMOVES every run of every registered credential as it passes
        // (render.ts, THE CREDENTIAL CHOKEPOINT), which is why this line has
        // no credential-specific belt of its own left. An error may never
        // reproduce a credential.
        detail: `token check failed: ${sanitizeServerField(
          err instanceof Error ? err.message : 'network error',
          SERVER_DETAIL_MAX,
        )}`,
        remedy: `check the network path and TACENDUM_API (current: ${API_BASE})`,
      });
    }
  }

  // --- ws: the socket host, which is NOT the API host ------------------------
  // A refused token still proves the handshake reached a server that answered,
  // so an AUTH-classified failure is reachability PASSING — the token's state
  // is the session check's finding, and duplicating it here would print two
  // FAILs for one cause.
  //
  // The same holds for EVERY refusal that carries an HTTP status, and this
  // check used to get that wrong the exact way the api check did before the
  // /health fix above: the incumbent-spared 503 — $connect probed the
  // account's one live connection, found it genuinely live, and spared it
  // (handlers/ws.ts, ws_connect_incumbent_spared) — was reported as
  // "unreachable", with a remedy that sent the operator hunting a firewall
  // that does not exist. On the machine most worth doctoring, the one whose
  // listen service is installed and running, that refusal is the NORMAL
  // state: doctor dialled into its own listener's claim and called the
  // correct answer a dead network.
  //
  // The classification reads the CliError's `status` field — wsclient.ts
  // attaches it for any answered upgrade, and for the local adapter's 1013
  // close — never the message prose. Only a status-less failure is left for
  // FAIL, and that set is exactly the one the remedy is true for: DNS, TLS,
  // a refused TCP connection, or the probe's own timeout.
  //
  // AN UNUSABLE TOKEN IS NOT PRESENTED, and the probe is made without one
  // instead of being skipped. Handing the dial a token this client has just
  // established it cannot send would put it in front of Node's header
  // validator for the second time in one command — the leak this file now
  // refuses at the top — and would answer the ws question with a rejection
  // that never left the machine. Reachability is this check's whole question,
  // an unauthenticated dial still answers it (the server refuses it, which
  // proves a server is there), and the token's own state is the session
  // check's finding, reported exactly once.
  try {
    await io.dialWs(tokenUsable ? token : '');
    results.push({ check: 'ws', ok: true, detail: `handshake completed (${WS_URL})` });
  } catch (err) {
    const status = err instanceof CliError ? err.status : undefined;
    if (err instanceof CliError && err.exitCode === EXIT.AUTH) {
      results.push({
        check: 'ws',
        ok: true,
        detail: `reachable (${WS_URL}) — it refused the token, which the session check reports`,
      });
    } else if (status === 503) {
      // One live connection per account is the design, so while the listen
      // service holds the socket every further listen-role dial is refused
      // exactly like this. Say so plainly; a diagnostic that names the
      // incumbent saves the operator from reading a healthy machine as a
      // broken one.
      results.push({
        check: 'ws',
        ok: true,
        detail:
          `reachable (${WS_URL}) — the server answered and refused this dial (HTTP 503): ` +
          'another live connection for this account already holds the socket. Normal while ' +
          'the listen service is running; not a fault',
      });
    } else if (status !== undefined) {
      results.push({
        check: 'ws',
        ok: true,
        detail:
          `reachable (${WS_URL}) — the dial was answered (HTTP ${status}) rather than ` +
          'completed. Reachability is this check\'s whole question, and the server spoke',
      });
    } else {
      results.push({
        check: 'ws',
        ok: false,
        // wsclient.ts builds this message around what the upgrade answered,
        // which on a status-less failure is the runtime's own transport prose
        // — the same class of string as the `/health` failure above, and owed
        // the same treatment for the same reason.
        detail: `${WS_URL} is unreachable (${sanitizeServerField(err instanceof Error ? err.message : 'unknown', SERVER_DETAIL_MAX)})`,
        remedy:
          `check TACENDUM_WS (current: ${WS_URL}) — the socket host is separate from the API ` +
          'host, so a firewall can pass one and eat the other',
      });
    }
  }

  return results;
}
