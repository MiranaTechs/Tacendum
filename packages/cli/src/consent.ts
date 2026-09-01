import { apiConsentDelete, apiConsentWrite } from './api.js';
import { CliError, EXIT } from './exit.js';
import { isUserId, loadProfile, normalizeUserId } from './profile.js';
import { type Reporter } from './output.js';
import { sanitizeServerField } from './render.js';
import { AuthSession } from './session.js';
import { FileStores } from './stores.js';

/**
 * `tacendum consent grant|revoke <account> <agent-id>` — the human's side of
 * the pairwise consent edge: grant writes the
 * directed (you -> agent) edge the server's send/inbox/typing predicates
 * enforce; revoke deletes it, and the next frame in either direction is
 * refused.
 *
 * The command PRESERVES the route's deliberate silence rather than
 * flattening it (the cmdCrewAdopt discipline):
 *
 *  - 204 means ACCEPTED, indistinguishably: stored, already stored, aimed at
 *    an id that names nothing, or silently dropped over the cap (a
 *    uniformity whose over-cap lossiness is deliberate and disclosed in
 *    shared/src/consent.ts). So our output says "recorded" and states
 *    exactly that ambiguity — a sentence claiming "the agent can now reach
 *    you" would assert what the wire deliberately does not answer.
 *  - There is deliberately no SERVER `consent list`: the server refuses
 *    consent enumeration to EVERYONE, the edge's own writer included
 *    — and the CLI never asks it to. What `consent list` prints is
 *    the CLIENT'S OWN MEMORY of the grants THIS CLIENT made
 *    (FileStores.loadConsentGrants — the machine_peers pattern the server
 *    route's header names as the intended shape), kept so a human can find
 *    a stale edge to revoke; without it, a full cap is unrecoverable
 *    except from ULIDs remembered by hand.
 *    No-enumeration is untouched: no route is asked, nothing is verified, and the
 *    copy says exactly whose record it is.
 *
 * In v1 this surface exists for CLI-account humans sharing rooms with
 * agents (and for the e2e gate that proves the predicate on the real wire);
 * the app's group-visible consent UX writes the same edges in a later
 * slice.
 */

export function cmdConsentList(name: string, report: Reporter): void {
  loadProfile(name);
  const grants = new FileStores(name).loadConsentGrants();
  const rows = Object.entries(grants).sort(([, a], [, b]) => a - b);
  report.emit(
    {
      ok: true,
      action: 'consent-list',
      account: name,
      grants: rows.map(([agent, at]) => ({ agent: sanitizeServerField(agent), grantedAt: at })),
    },
    rows.length === 0
      ? `${name}: no consent grants recorded on this machine. This is this client's own ` +
          'record of what IT granted — the server keeps no readable list, deliberately, ' +
          'and grants made elsewhere do not appear here.'
      : `${name}: consent grants recorded on this machine (this client's own record — ` +
          'the server keeps no readable list, and grants made elsewhere do not appear):\n' +
          rows
            .map(
              ([agent, at]) =>
                `  ${sanitizeServerField(agent)}  (granted ${new Date(at).toISOString().slice(0, 10)})`,
            )
            .join('\n') +
          '\nRevoke any with: tacendum consent revoke ' + name + ' <agent-id>',
  );
}

export async function cmdConsent(
  action: 'grant' | 'revoke',
  name: string,
  rawAgent: string,
  report: Reporter,
): Promise<void> {
  const profile = loadProfile(name);

  if (profile.accountClass === 'integration') {
    // The server would refuse too (403 integration_forbidden) — an
    // injectable node never writes authorization state — but the fixable
    // mistake is HERE: consent is the human's own act, made from the human
    // account.
    throw new CliError(
      EXIT.USAGE,
      `${name} is an integration, and an integration can never write consent edges — ` +
        'run this from the HUMAN account that is choosing to share',
    );
  }
  if (!isUserId(rawAgent)) {
    // The VALUE is not echoed (the cmdCrewAdopt rule): a
    // misconfigured variable puts a secret in this argument, and this error
    // reaches stderr and --json.
    throw new CliError(
      EXIT.USAGE,
      'that is not a user id — an agent id is 26 characters of Crockford base32, ' +
        'printed by `tacendum whoami <name>` on the agent account',
    );
  }
  const agent = normalizeUserId(rawAgent);
  if (agent === profile.userId) {
    throw new CliError(EXIT.USAGE, 'you cannot consent to yourself');
  }

  const stores = new FileStores(name);
  const auth = new AuthSession(name, stores);
  if (action === 'grant') {
    report.status('recording consent…');
    await apiConsentWrite(auth, agent);
    // The CLIENT's own memory of its own act (the header's list paragraph):
    // recorded AFTER the 204 so a refused write records nothing, best-effort
    // so a full disk cannot un-grant what the server just accepted.
    try {
      stores.recordConsentGrant(agent, Date.now());
    } catch {
      /* the grant stands; only the local list is poorer */
    }
    // The honest sentence for a deliberately uniform answer — see the
    // header. `agent` is shape-locked above; the sanitizer is belt.
    report.emit(
      { ok: true, action: 'consented', account: name, agent: sanitizeServerField(agent) },
      `${name}: consent recorded for ${sanitizeServerField(agent)} — if that id is an AI agent, ` +
        'it may now exchange messages with you. The server answers the same for any id ' +
        '(deliberate — the route teaches nothing about who exists), and quietly stores ' +
        'nothing beyond your edge cap. Revoke any time: `tacendum consent revoke`; ' +
        'this machine remembers its own grants: `tacendum consent list`.',
    );
    return;
  }
  report.status('revoking consent…');
  await apiConsentDelete(auth, agent);
  try {
    stores.removeConsentGrant(agent);
  } catch {
    /* the revoke stands; the local list may keep a stale row to re-revoke */
  }
  report.emit(
    { ok: true, action: 'revoked', account: name, agent: sanitizeServerField(agent) },
    `${name}: consent revoked for ${sanitizeServerField(agent)} — the server refuses its next ` +
      'message to you and your next message to it (a revoke of an id you never consented ' +
      'to answers the same). Messages already queued before the revoke can still drain ' +
      'for up to their 30-day life.',
  );
}
