import { CREW_MAX_MEMBERS } from '@tacendum/shared';
import { apiCrewAdopt } from './api.js';
import { CliError, EXIT } from './exit.js';
import { isUserId, loadProfile, normalizeUserId } from './profile.js';
import { type Reporter } from './output.js';
import { sanitizeServerField } from './render.js';
import { AuthSession } from './session.js';
import { FileStores } from './stores.js';

/**
 * `tacendum crew adopt <account> <member-id>` — the owner-side admission
 * call (crew-chat spec, Task B; server contract in handlers/crew.ts).
 *
 * The command PRESERVES the route's semantics rather than flattening them:
 *
 *  - The server collapses "not an integration", "bound to someone else" and
 *    "in someone else's crew" into ONE refusal so the route cannot be used
 *    as an oracle for which ids are integrations and whose they are. The CLI
 *    does not try to be cleverer than that — one message, one remedy.
 *  - 204 means adopted OR already adopted, indistinguishably. So does our
 *    output.
 *  - `crew_contended` is transient contention on state the caller may
 *    write, NOT a refusal: the identical call against quiet state succeeds.
 *    The handler always answers it with `retry-after: 1`, so the retry
 *    below sleeps that constant second; if the server ever varies the
 *    header, the value belongs on CliError at the `request()` layer, not
 *    parsed back out of message prose here.
 *
 * There is deliberately no `crew list` and no `crew remove`: the server
 * exposes neither — a crew cannot be enumerated, even by its owner, and the
 * CLI does not fake either from local state it cannot verify.
 */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const CONTENDED_ATTEMPTS = 3;

export async function cmdCrewAdopt(
  name: string,
  rawMember: string,
  report: Reporter,
): Promise<void> {
  const profile = loadProfile(name);

  if (profile.accountClass === 'integration') {
    // Refused locally for the same reason cmdPair refuses a non-integration:
    // the server would refuse too (403 integration_forbidden), but the
    // fixable mistake is HERE — adoption is the owner's call, so it must run
    // from the human account, and the class was fixed at registration.
    throw new CliError(
      EXIT.USAGE,
      `${name} is an integration, and an integration can never adopt crew members — ` +
        'run this from the OWNER account the members are paired to',
    );
  }
  if (!isUserId(rawMember)) {
    // The VALUE is not echoed — same rule, same reason as cmdPair: a
    // misconfigured variable puts a secret in this argument, and this error
    // reaches stderr and --json.
    throw new CliError(
      EXIT.USAGE,
      'that is not a user id — a member id is 26 characters of Crockford base32, ' +
        'printed by `tacendum whoami <name>` on the member account',
    );
  }
  const member = normalizeUserId(rawMember);
  if (member === profile.userId) {
    throw new CliError(EXIT.USAGE, 'an owner cannot adopt themselves');
  }

  const auth = new AuthSession(name, new FileStores(name));
  report.status('adopting…');
  for (let attempt = 1; ; attempt += 1) {
    try {
      await apiCrewAdopt(auth, member);
      break;
    } catch (err) {
      if (!(err instanceof CliError)) throw err;
      switch (err.code) {
        case 'crew_contended':
          if (attempt < CONTENDED_ATTEMPTS) {
            report.status('the server answered contended — retrying…');
            await sleep(1000);
            continue;
          }
          // Say what was OBSERVED, not a mechanism we inferred: three
          // contended answers in a row. (The gate checked the first draft's
          // story — "the crew kept moving under concurrent adopts" — against
          // production behavior, where the crew id is written if_not_exists
          // and never moves; persistent contention has no honest local
          // diagnosis beyond the answers themselves, so the remedy is a
          // plain retry, not advice about other callers we cannot see.)
          throw new CliError(
            EXIT.ERROR,
            'the server answered contended three times — the request is fine; retry in a moment',
            undefined,
            err.code,
            err.status,
          );
        case 'cap_reached':
          throw new CliError(
            EXIT.ERROR,
            `the crew is full (max ${CREW_MAX_MEMBERS} members) — revoke a member from the ` +
              'phone to free a slot',
            undefined,
            err.code,
            err.status,
          );
        case 'not_integration_owner':
          // One server code for three conditions, by design (see header).
          // REFUSED, not ERROR: this is a permanent policy answer — exit.ts
          // reserves 10 for exactly this, and a script retrying a refusal
          // because it read exit 1 is the mistake the distinction exists for
          // (an earlier review). One exit for all three collapsed causes keeps
          // the ambiguity the server built.
          throw new CliError(
            EXIT.REFUSED,
            'that account is not an integration you own — only integrations PAIRED to this ' +
              'account can join its crew (`tacendum pair <member> <your-id>` pairs one), and ' +
              'the server deliberately says no more than that',
            undefined,
            err.code,
            err.status,
          );
        case 'not_found':
          throw new CliError(
            EXIT.ERROR,
            'no such account on the server — register the member before adopting it',
            undefined,
            err.code,
            err.status,
          );
        case 'unknown_owner':
          throw new CliError(
            EXIT.ERROR,
            `${name} no longer resolves to a human account on the server — its token has ` +
              'outlived its row',
            undefined,
            err.code,
            err.status,
          );
        default:
          throw err;
      }
    }
  }

  // THE 204 IS RECORDED: the server's positive answer is the one
  // honest moment this CLI learns MEMBER is a machine this owner paired, and
  // the record is what lets this owner's roster writes carry
  // `class: 'integration'` so a room's second human can be offered the consent
  // choice before the agent ever speaks. Best-effort: a full disk must not
  // turn a server-accepted adopt into a reported failure.
  try {
    new FileStores(name).recordMachinePeer(member, Date.now());
  } catch {
    /* the adopt stands; only this client's memory is poorer */
  }

  // `member` is operator-typed but shape-locked above (26 chars of Crockford
  // base32, normalized) — the sanitizer is belt on a value that cannot carry
  // anything, the same posture as cmdPair's emit.
  report.emit(
    { ok: true, action: 'adopted', account: name, member: sanitizeServerField(member) },
    `${name}: adopted ${sanitizeServerField(member)} into your crew — it can now message ` +
      'you and its crew-mates (a re-adopt answers the same)',
  );
}
