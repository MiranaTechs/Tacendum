/**
 * THE USERNAME PLUMBING, DARK BEHIND THE BUILD PIN (part A — no screens
 * yet; the surfaces are part B). The verify's
 * properties that plumbing alone can prove, each against the real modules
 * and (for the migration) the REAL SQLite engine:
 *
 *  1. THE PIN is a typed `true` in the shipped source (the phoneUi
 *     pattern; OFF through build 22, flipped ON in build 23), and NO file outside the pin-gated set and the copy deck
 *     spells the word — the census is two-way (a stale allowlist row fails).
 *
 *  2. THE COPY GATE: the honesty sentences ship verbatim; nothing near
 *     the class claims the server is blind to the name; no `@` sigil; the
 *     `taken` and the generic-retry sentences are distinct and the latter
 *     never says why.
 *
 *  3. THE WIRE, through the REAL serializer against the shared schemas: the
 *     four lifecycle routes and the third lookup field — and the frozen 409
 *     surfaces as an ApiRequestError carrying that status.
 *
 *  4. THE OUTCOME MAP (accountsUsername.ts): 409 → 'taken', 403 → 'refused',
 *     transport → 'failed', a bad shape → 'invalid' and a reserved name
 *     (exact AND skeleton) → 'reserved', both BEFORE any wire call;
 *     refusal-first (nothing saved on taken/refused); rename spelled from
 *     the local row; consent recorded exactly as sent.
 *
 *  5. THE ROW (db.ts kind='username'): the per-class shape, cleared alone;
 *     the notice row; DB_TABLES; the provenance mark is a server
 *     introduction.
 *
 *  6. THE MIGRATION on the real engine: an earlier file's CHECK widens with
 *     both landed rows raw-equal; idempotent; recovery_local still REFUSES
 *     the kind (recovery exclusion, structural).
 *
 *  7. DURESS: the api chokepoint refuses every username call as a transport
 *     failure (→ 'failed', nothing written), and the row lands in the decoy
 *     file when the decoy workspace is active.
 *
 *  8. NOTICES: an unknown future kind is IGNORED (acked, never a parse
 *     failure); a known kind with a bad body still drops; `usernameRevoked`
 *     clears the row, stores the notice, fires the listener; a rider reason
 *     never surfaces.
 *
 *  9. PROVENANCE: `startDiscoveredChat` records 'discovery-username'
 *     when told to, 'discovery' by default, touching no api either way.
 *
 * 10. THE PIN, BOTH WAYS, API SPY: with the pin OFF (the module mock,
 *     driven exactly as the username-ux suite drives it) the landed
 *     discovery surface makes no username call — none of the six — and
 *     with the pin ON (build 23's shipped value) the find-by-name chip
 *     drives the ONE lookup call over the shared route; and statically, no
 *     production file outside the module imports the username wire.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { TextInput } from 'react-native';
import {
  AccountsNotice,
  DiscoveryLookupRequest,
  SetDiscoverableRequest,
  USERNAME_TAKEN_BODY,
  USERNAME_TAKEN_STATUS,
  UsernameClaimRequest,
  UsernameEligibilityResponse,
  UsernameUnlinkRequest,
  type AccountsNoticeFrame,
} from '@tacendum/shared';
import * as api from '../src/api';
import { ApiRequestError } from '../src/api';
import * as accounts from '../src/accounts';
import * as accountsUsername from '../src/accountsUsername';
import { ACCOUNTS_USERNAME_COPY } from '../src/accountsUsernameCopy';
import * as db from '../src/db';
import { handleAccountsNoticeFrame, onUsernameNotice, type LinkingDeps } from '../src/linking';
import * as reauth from '../src/reauth';
import { session } from '../src/session';
import { AccountUsernameScreen } from '../src/screens/AccountUsernameScreen';
import { DiscoveryScreen } from '../src/screens/DiscoveryScreen';

jest.mock('../src/registration', () => ({
  createOrRestoreAccount: jest.fn(),
}));

/** The build pin, flipped per test — the username-ux pattern verbatim: a
 * getter, so every render reads the CURRENT value. Default ON (build 23's
 * shipped value); section 10's dark half sets it false explicitly, which
 * is what keeps "pin OFF → zero username calls" PROVABLE after the flip
 * rather than a sentence about a binary nobody ships any more. Section 1
 * reads the REAL module (requireActual) so the shipped literal stays
 * pinned regardless of this mock. */
let mockUsernameUiEnabled = true;
jest.mock('../src/usernameUi', () => ({
  get USERNAME_UI_ENABLED() {
    return mockUsernameUiEnabled;
  },
}));

// The app's tsconfig types only `jest`; node's modules are present at
// runtime (the android.copy.divergences idiom).
const { readFileSync, readdirSync, statSync } = require('fs') as {
  readFileSync: (path: string, encoding: string) => string;
  readdirSync: (path: string) => string[];
  statSync: (path: string) => { isDirectory: () => boolean };
};
const { join, relative } = require('path') as {
  join: (...parts: string[]) => string;
  relative: (from: string, to: string) => string;
};
declare const __dirname: string;
const APP_ROOT = join(__dirname, '..');

const ANCHOR = '01HQZZZZ00000000000000000A';
const SELF = '01HQSELF000000000000000000';
const OTHER = '01HQOTHR000000000000000000';
const GROUP = '01HQGGGG0000000000000000G0';
const NOW_MS = 1_756_000_000_000;
const REFUSAL = () => new ApiRequestError('refused', 403, 'accounts_refused');
const TAKEN = () => new ApiRequestError('taken', USERNAME_TAKEN_STATUS);
const TRANSPORT = () => new TypeError('Network request failed');

function productionFiles(): string[] {
  const out: string[] = [join(APP_ROOT, 'App.tsx')];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(name)) out.push(full);
    }
  };
  walk(join(APP_ROOT, 'src'));
  return out;
}

function b64(text: string): string {
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < text.length; i += 3) {
    const a = text.charCodeAt(i);
    const b = i + 1 < text.length ? text.charCodeAt(i + 1) : NaN;
    const c = i + 2 < text.length ? text.charCodeAt(i + 2) : NaN;
    const n = (a << 16) | ((Number.isNaN(b) ? 0 : b) << 8) | (Number.isNaN(c) ? 0 : c);
    out += alphabet[(n >> 18) & 63]! + alphabet[(n >> 12) & 63]!;
    out += Number.isNaN(b) ? '=' : alphabet[(n >> 6) & 63]!;
    out += Number.isNaN(c) ? '=' : alphabet[n & 63]!;
  }
  return out;
}

/* ── the call-ledger fake (the phone-ux discipline) ────────────────── */

function fakeUsernameDeps(
  overrides: Partial<accountsUsername.AccountsUsernameDeps['api']> = {},
  held: db.UsernameIdentifierRow | null = null,
): {
  deps: accountsUsername.AccountsUsernameDeps;
  saved: db.UsernameIdentifierRow[];
  cleared: number[];
  apiCalls: Array<[string, unknown[]]>;
} {
  const saved: db.UsernameIdentifierRow[] = [];
  const cleared: number[] = [];
  const apiCalls: Array<[string, unknown[]]> = [];
  let row = held;
  const record =
    (name: string) =>
    async (...args: unknown[]): Promise<void> => {
      apiCalls.push([name, args]);
    };
  const deps: accountsUsername.AccountsUsernameDeps = {
    api: {
      usernameClaim: record('usernameClaim'),
      usernameRename: record('usernameRename'),
      usernameUnlink: record('usernameUnlink'),
      setUsernameDiscoverable: record('setUsernameDiscoverable'),
      discoveryLookupUsername: async (...args: unknown[]) => {
        apiCalls.push(['discoveryLookupUsername', args]);
        return { members: [{ userId: ANCHOR, class: 'phone' as const }], rosterVersion: 1 };
      },
      ...overrides,
    },
    db: {
      loadUsernameIdentifier: async () => row,
      saveUsernameIdentifier: async r => {
        row = { ...r };
        saved.push({ ...r });
      },
      clearUsernameIdentifier: async () => {
        row = null;
        cleared.push(1);
      },
      saveUsernameUnlink: async () => undefined,
      clearUsernameUnlink: async () => undefined,
      loadUsernameCooldown: async () => null,
      saveUsernameCooldown: async () => undefined,
      clearUsernameCooldown: async () => undefined,
    },
    token: async () => 'bearer',
    now: () => NOW_MS,
  };
  return { deps, saved, cleared, apiCalls };
}

async function render(el: React.ReactElement): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(el);
  });
  return tree;
}

async function press(tree: ReactTestRenderer.ReactTestRenderer, testID: string): Promise<void> {
  const node = tree.root.findAllByProps({ testID }).find(n => n.props.onPress !== undefined)!;
  await ReactTestRenderer.act(async () => {
    node.props.onPress();
  });
}

async function type(tree: ReactTestRenderer.ReactTestRenderer, text: string): Promise<void> {
  const input = tree.root.findAllByType(TextInput)[0]!;
  await ReactTestRenderer.act(async () => {
    input.props.onChangeText(text);
  });
}

afterEach(() => {
  mockUsernameUiEnabled = true;
  session.setMode('real');
  jest.restoreAllMocks();
});

/* ── 1. the pin and the word census ─────────────────────────────────── */

describe('the build pin (usernameUi.ts — the phoneUi pattern)', () => {
  it('ships true (build 23), typed boolean, on exactly the pinned line', () => {
    // The REAL module, past the per-test mock above: this is the literal a
    // store binary compiles, not the suite's switch.
    const real = jest.requireActual<{ USERNAME_UI_ENABLED: boolean }>('../src/usernameUi');
    expect(real.USERNAME_UI_ENABLED).toBe(true);
    const src = readFileSync(join(APP_ROOT, 'src', 'usernameUi.ts'), 'utf8');
    expect(src).toContain('export const USERNAME_UI_ENABLED: boolean = true;');
    // Never a runtime read: no env, no fetch, no import beyond the constant.
    expect(src).not.toMatch(/import\b|process\.env|fetch\(/);
  });
});

/**
 * WHERE THE WORD MAY LIVE ("username" appears in app
 * copy only when and where the feature ships). Pin-gated modules, the
 * copy deck, and the plumbing that carries the class without rendering it:
 * db.ts is the ONE kind-spelling site (and the provenance mark's), api.ts
 * carries the route strings, linking.ts the notice kind, accounts.ts the
 * provenance parameter. Part B (the surfaces) added exactly the pin-gated
 * readers: the screen, the two screens that mount a pin-conditional entry
 * (Settings row, discovery chip), App.tsx (the route + the mount, the
 * screen rendering null under the pin), and visibleSurface.ts (the route
 * NAME in the union — a fact the census holds either way). ui/, every
 * other copy deck, every other screen — none may spell it.
 */
const USERNAME_WORD_ALLOWLIST: ReadonlyArray<{ file: string; why: string }> = [
  { file: 'src/usernameUi.ts', why: 'the pin itself' },
  { file: 'src/accountsUsername.ts', why: 'the dark module (pin-gated callers only)' },
  { file: 'src/accountsUsernameCopy.ts', why: 'the copy deck (pin-gated readers only)' },
  { file: 'src/db.ts', why: 'the ONE kind-spelling site + the provenance mark' },
  { file: 'src/api.ts', why: 'the route strings + the lookup field (wire, not surface)' },
  { file: 'src/linking.ts', why: 'the usernameRevoked notice kind (the arming order)' },
  { file: 'src/accounts.ts', why: 'the startDiscoveredChat provenance parameter' },
  // Part B — the pin-gated surfaces.
  { file: 'src/screens/AccountUsernameScreen.tsx', why: 'the surface (renders null under the pin)' },
  { file: 'src/screens/SettingsScreen.tsx', why: 'the Settings row (rendered only under the pin)' },
  { file: 'src/screens/DiscoveryScreen.tsx', why: 'the third class chip (rendered only under the pin)' },
  { file: 'App.tsx', why: 'the route name + the mount (the screen renders null under the pin)' },
  { file: 'src/visibleSurface.ts', why: 'the route name in the 22-name union' },
  // The pin-flip build (23): the registration reach sentence names the
  // class a person can now actually be found by — the clause is interpolated
  // only under the pin, so a pin-OFF binary's sentence is byte-unchanged.
  { file: 'src/screens/RegisterScreen.tsx', why: 'the OPTIONAL_HANDLE reach clause (interpolated only under the pin)' },
  // Build 33: Start a chat's one smart field (it replaced build 24's find
  // door) — the username kind, its copy and the find answers are chosen
  // from the deck only under the pin, byte-unchanged pin-OFF.
  { file: 'src/screens/StartChatScreen.tsx', why: 'the smart field’s username kind, copy and find answers, chosen from the deck only under the pin' },
  // Build 33: the inline find that replaced the trip to DiscoveryScreen.
  { file: 'src/screens/startChat/useReachLookup.ts', why: 'the inline find: username eligibility preflight, lookup and the own-name self key, all under the pin' },
  // The 2026-10-08 proof pass: the one module that reads the pin and
  // answers in class-neutral words, so the email deck can scope "off means
  // nobody can look you up" to this email and the downgrade can name the
  // claimed name — without either spelling the class.
  { file: 'src/findableClasses.ts', why: 'reads the pin once and exports class-neutral facts (HANDLE_CLASS_LIVE, OTHER_FINDABLE_CLASS_LIVE) for the email deck' },
];

/** The files that may IMPORT the dark module or the pin (part B's readers,
 * plus the reach sentence's pin read); every other production file must
 * reach neither. */
const USERNAME_IMPORTER_ALLOWLIST: ReadonlySet<string> = new Set([
  'src/screens/AccountUsernameScreen.tsx',
  'src/screens/SettingsScreen.tsx',
  'src/screens/DiscoveryScreen.tsx',
  'src/screens/RegisterScreen.tsx',
  'src/screens/StartChatScreen.tsx',
  // Build 33: the inline find calls the module and reads the pin.
  'src/screens/startChat/useReachLookup.ts',
  // fix/username-discovery (2026-10-08): the email and phone verbs
  // (attach, remove, the consent toggle) change the facts the caller-owned
  // state read carries, so accounts.ts invalidates that read's memory after
  // each of them — the one import it makes from the module, and no surface.
  'src/accounts.ts',
  // The gate pass (2026-10-08): every roster change linking.ts lands — a
  // link completed on either side, a member* notice, a revocation — changes
  // what that read would answer, so linking.ts invalidates it too. The one
  // import, call-time only; no surface.
  'src/linking.ts',
  // The proof pass (2026-10-08): the class-neutral facts module reads the
  // pin so the email deck need not.
  'src/findableClasses.ts',
]);

/** An import of the module or the pin from ANY depth (build 33 widened it:
 * the one-level form could not see a file under src/screens/startChat/). */
const USERNAME_IMPORT_RE = /from '(\.\.?\/)+(accountsUsername|usernameUi)'/;

describe('the word census: "username" lives only in the allowlisted files (two-way)', () => {
  const hits = new Map<string, number[]>();
  for (const full of productionFiles()) {
    const rel = relative(APP_ROOT, full).split('\\').join('/');
    readFileSync(full, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (/username/i.test(line)) hits.set(rel, [...(hits.get(rel) ?? []), i + 1]);
      });
  }

  it('no screen, App.tsx, ui piece, or other deck spells the word', () => {
    const offenders = [...hits.keys()].filter(
      file => !USERNAME_WORD_ALLOWLIST.some(row => row.file === file),
    );
    expect(offenders.map(f => `${f}:${hits.get(f)!.join(',')}`)).toEqual([]);
  });

  it('every allowlist row still matches something — stale rows come off the list', () => {
    expect(USERNAME_WORD_ALLOWLIST.filter(row => !hits.has(row.file))).toEqual([]);
  });

  it('no production file outside the module imports the username wire or the module itself outside the pin-gated set', () => {
    const importers: string[] = [];
    for (const full of productionFiles()) {
      const rel = relative(APP_ROOT, full).split('\\').join('/');
      const src = readFileSync(full, 'utf8');
      if (/api(Claim|Rename|Unlink|SetUsernameDiscoverable|DiscoveryLookup)Username/.test(src) && rel !== 'src/api.ts' && rel !== 'src/accountsUsername.ts') {
        importers.push(rel);
      }
      if (USERNAME_IMPORT_RE.test(src) && !USERNAME_IMPORTER_ALLOWLIST.has(rel)) {
        importers.push(`${rel} imports module`);
      }
    }
    // Part B mounts the surfaces: only the pin-gated readers import the
    // module or the pin; App.tsx reaches the class through the screen alone.
    expect(importers).toEqual([]);
  });

  it('every importer-allowlist row actually imports the module or the pin — stale rows come off the list', () => {
    for (const rel of USERNAME_IMPORTER_ALLOWLIST) {
      const src = readFileSync(join(APP_ROOT, rel), 'utf8');
      expect([rel, USERNAME_IMPORT_RE.test(src)]).toEqual([rel, true]);
    }
  });
});

/* ── 2. the copy gate ───────────────────────────────────────────────── */

describe('the copy gate (honesty, display posture, refusal render)', () => {
  const deck = JSON.stringify(ACCOUNTS_USERNAME_COPY);

  it('ships the three honesty sentences verbatim, behind the info affordance', () => {
    expect(ACCOUNTS_USERNAME_COPY.infoLines).toContain(
      'A username is public by nature — an email address or phone number is private information; a username is not. We store only a scrambled form of your username, never the name itself, so a leak of our records alone does not reveal it.',
    );
    expect(ACCOUNTS_USERNAME_COPY.infoLines).toContain(
      'Usernames are short and guessable, so the real protections are limits, not scrambling: every search and every claim attempt is strictly limited and monitored, no one using the app can find your account by name unless you allow it, and you can change or remove your name at any time.',
    );
    expect(ACCOUNTS_USERNAME_COPY.infoLines).toContain('Treat your username as public information.');
  });

  it('nothing near the class claims the server is blind to the name — deck values AND both source files', () => {
    const forbidden = /server never sees|server-blind|never sees (it|your|the)|server cannot see|blind to your/i;
    expect(deck).not.toMatch(forbidden);
    for (const file of ['src/accountsUsernameCopy.ts', 'src/accountsUsername.ts', 'src/usernameUi.ts']) {
      expect(readFileSync(join(APP_ROOT, file), 'utf8')).not.toMatch(forbidden);
    }
  });

  it('no @ sigil anywhere in the deck (a finding label, never a name layer)', () => {
    expect(deck.includes('@')).toBe(false);
  });

  it('taken and the generic retry are distinct sentences, and the retry never says why (distinguishable by status alone)', () => {
    expect(ACCOUNTS_USERNAME_COPY.taken).not.toBe(ACCOUNTS_USERNAME_COPY.tryLater);
    expect(ACCOUNTS_USERNAME_COPY.taken.toLowerCase()).toContain('taken');
    expect(ACCOUNTS_USERNAME_COPY.tryLater.toLowerCase()).not.toMatch(/taken|busy|limit|budget|too many|quota/);
  });

  it('the revocation copy is FIXED and reasonless — it names what is unchanged and never a cause', () => {
    expect(ACCOUNTS_USERNAME_COPY.revokedBody).toContain('only the name is gone');
    expect(ACCOUNTS_USERNAME_COPY.revokedBody.toLowerCase()).not.toMatch(/because|impersonat|reason|violat/);
  });

  it('no device noun rides this deck (the per-idiom census stays at its count)', () => {
    expect(readFileSync(join(APP_ROOT, 'src', 'accountsUsernameCopy.ts'), 'utf8')).not.toContain('DEVICE_NOUN');
    expect(deck).not.toMatch(/iphone|ipad/i);
  });
});

/* ── 3. the wire, through the real serializer ───────────────────────── */

describe('the username payloads survive the REAL serializer against the shared wire schemas', () => {
  const realFetch = globalThis.fetch;
  let calls: { path: string; body: unknown }[];
  let nextStatus: number;
  let nextText: string;

  beforeEach(() => {
    calls = [];
    nextStatus = 200;
    nextText = '{}';
    globalThis.fetch = jest.fn(async (url: unknown, init?: { body?: string }) => {
      calls.push({
        path: String(url),
        body: init?.body === undefined ? undefined : JSON.parse(init.body),
      });
      return {
        ok: nextStatus >= 200 && nextStatus < 300,
        status: nextStatus,
        json: async () => JSON.parse(nextText),
      };
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('claim and rename: {username, discoverable} through their own routes — the consent bit EXPLICIT', async () => {
    await api.apiClaimUsername('tok', 'alice_7', true);
    await api.apiRenameUsername('tok', 'alice_8', false);
    expect(calls[0]!.path.endsWith('/v1/identifiers/username/claim')).toBe(true);
    expect(calls[1]!.path.endsWith('/v1/identifiers/username/rename')).toBe(true);
    for (const [i, want] of [[0, true], [1, false]] as const) {
      const body = calls[i]!.body as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(['discoverable', 'username']);
      expect(UsernameClaimRequest.safeParse(body).success).toBe(true);
      expect(body.discoverable).toBe(want);
    }
    // Teeth: the bit is REQUIRED (the server's .strict() + explicit bit).
    expect(UsernameClaimRequest.safeParse({ username: 'alice_7' }).success).toBe(false);
  });

  it('unlink: the pinned empty body; discoverable: {discoverable} — both on the class route', async () => {
    await api.apiUnlinkUsername('tok');
    await api.apiSetUsernameDiscoverable('tok', true);
    expect(calls[0]!.path.endsWith('/v1/identifiers/username/unlink')).toBe(true);
    expect(calls[0]!.body).toEqual({});
    expect(UsernameUnlinkRequest.safeParse(calls[0]!.body).success).toBe(true);
    expect(calls[1]!.path.endsWith('/v1/identifiers/username/discoverable')).toBe(true);
    expect(Object.keys(calls[1]!.body as object)).toEqual(['discoverable']);
    expect(SetDiscoverableRequest.safeParse(calls[1]!.body).success).toBe(true);
  });

  it('eligibility: GET carries no body and accepts only the caller-owned proof boolean', async () => {
    nextText = JSON.stringify({ hasVerifiedIdentifier: true });
    await expect(api.apiUsernameEligibility('tok')).resolves.toEqual({
      hasVerifiedIdentifier: true,
    });
    expect(calls[0]!.path.endsWith('/v1/identifiers/username/eligibility')).toBe(true);
    expect(calls[0]!.body).toBeUndefined();
    expect(UsernameEligibilityResponse.safeParse({ hasVerifiedIdentifier: true }).success).toBe(
      true,
    );
    expect(
      UsernameEligibilityResponse.safeParse({ hasVerifiedIdentifier: true, reason: 'missing' })
        .success,
    ).toBe(false);
  });

  it('discovery: the ONE lookup route, the THIRD parallel field, exactly-one-of, .strict()', async () => {
    nextText = JSON.stringify({ members: [{ userId: ANCHOR, class: 'phone' }], rosterVersion: 1 });
    await api.apiDiscoveryLookupUsername('tok', 'alice_7');
    expect(calls[0]!.path.endsWith('/v1/discovery/lookup')).toBe(true);
    const body = calls[0]!.body as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['username']);
    expect(DiscoveryLookupRequest.safeParse(body).success).toBe(true);
    expect(DiscoveryLookupRequest.safeParse({ ...body, email: 'a@b.co' }).success).toBe(false);
    expect(DiscoveryLookupRequest.safeParse({ ...body, phone: '+15555550100' }).success).toBe(false);
  });

  it('the frozen 409 surfaces as an ApiRequestError carrying USERNAME_TAKEN_STATUS; the frozen 403 as one carrying 403', async () => {
    nextStatus = USERNAME_TAKEN_STATUS;
    nextText = USERNAME_TAKEN_BODY;
    await expect(api.apiClaimUsername('tok', 'alice_7', true)).rejects.toMatchObject({
      name: 'ApiRequestError',
      status: USERNAME_TAKEN_STATUS,
    });
    nextStatus = 403;
    nextText = JSON.stringify({ error: { code: 'accounts_refused', detail: 'refused' } });
    await expect(api.apiClaimUsername('tok', 'alice_7', true)).rejects.toMatchObject({
      name: 'ApiRequestError',
      status: 403,
      code: 'accounts_refused',
    });
  });
});

/* ── 4. the outcome map ─────────────────────────────────────────────── */

describe('claimUsername — the outcome map (refusal-first)', () => {
  it('claimed: the normalized name, the claim time, and the consent bit exactly as sent', async () => {
    const { deps, saved, apiCalls } = fakeUsernameDeps();
    expect(await accountsUsername.claimUsername('  Alice_7 ', true, deps)).toBe('claimed');
    expect(apiCalls).toEqual([['usernameClaim', ['bearer', 'alice_7', true]]]);
    expect(saved).toEqual([{ username: 'alice_7', claimedAt: NOW_MS, discoverable: true }]);
  });

  it('an unchecked consent box is a legal claim, recorded OFF — held but unfindable, shown honestly', async () => {
    const { deps, saved } = fakeUsernameDeps();
    expect(await accountsUsername.claimUsername('bob', false, deps)).toBe('claimed');
    expect(saved[0]!.discoverable).toBe(false);
  });

  it('renamed: a held name spells the RENAME route with the same body; the row moves to the new name', async () => {
    const held = { username: 'alice_7', claimedAt: 1, discoverable: true };
    const { deps, saved, apiCalls } = fakeUsernameDeps({}, held);
    expect(await accountsUsername.claimUsername('alice_8', true, deps)).toBe('renamed');
    expect(apiCalls).toEqual([['usernameRename', ['bearer', 'alice_8', true]]]);
    expect(saved).toEqual([{ username: 'alice_8', claimedAt: NOW_MS, discoverable: true }]);
  });

  it('409 → taken, by STATUS alone — nothing saved', async () => {
    const { deps, saved } = fakeUsernameDeps({
      usernameClaim: async () => {
        throw TAKEN();
      },
    });
    expect(await accountsUsername.claimUsername('alice_7', true, deps)).toBe('taken');
    expect(saved).toEqual([]);
  });

  it('403 (the frozen refusal — fleet ceiling, budget, gate, cool-down alike) → refused; a 429 or 500 is refused too — never taken', async () => {
    for (const status of [403, 429, 500]) {
      const { deps, saved } = fakeUsernameDeps({
        usernameClaim: async () => {
          throw new ApiRequestError('x', status);
        },
      });
      expect(await accountsUsername.claimUsername('alice_7', true, deps)).toBe('refused');
      expect(saved).toEqual([]);
    }
  });

  it('a transport failure → failed; a missing token → failed, with no wire call', async () => {
    const { deps, saved } = fakeUsernameDeps({
      usernameClaim: async () => {
        throw TRANSPORT();
      },
    });
    expect(await accountsUsername.claimUsername('alice_7', true, deps)).toBe('failed');
    expect(saved).toEqual([]);
    const noToken = fakeUsernameDeps();
    noToken.deps.token = async () => null;
    expect(await accountsUsername.claimUsername('alice_7', true, noToken.deps)).toBe('failed');
    expect(noToken.apiCalls).toEqual([]);
  });

  it('a bad shape → invalid BEFORE any wire call (refused, never repaired)', async () => {
    for (const bad of ['ab', '_alice', '9lives', 'al ice', 'al-ice', 'ålice', 'alice@example.com', '+15558675309', `b${'x'.repeat(32)}`]) {
      const { deps, apiCalls } = fakeUsernameDeps();
      expect(await accountsUsername.claimUsername(bad, true, deps)).toBe('invalid');
      expect(apiCalls).toEqual([]);
    }
  });

  it('a reserved name → reserved BEFORE any wire call: exact, case-folded, AND skeleton-vs-skeleton (adm1n, m0derator, rnirana)', async () => {
    for (const reserved of ['admin', 'ADMIN', ' Tacendum ', 'adm1n', 'm0derator', 'rnirana', 'supp0rt', 'sta_ff']) {
      const { deps, apiCalls } = fakeUsernameDeps();
      expect([reserved, await accountsUsername.claimUsername(reserved, true, deps)]).toEqual([reserved, 'reserved']);
      expect(apiCalls).toEqual([]);
      expect([reserved, accountsUsername.checkUsernameLocally(reserved)]).toEqual([reserved, 'reserved']);
    }
    expect(accountsUsername.checkUsernameLocally('alice_7')).toBe('ok');
    expect(accountsUsername.checkUsernameLocally('ab')).toBe('invalid');
  });
});

describe('setUsernameDiscoverable / unlinkUsername / discoverySearchByUsername', () => {
  it('the toggle records this device\'s own decision on the username row alone, refusal-first', async () => {
    const held = { username: 'alice_7', claimedAt: 1, discoverable: true };
    const ok = fakeUsernameDeps({}, held);
    expect(await accountsUsername.setUsernameDiscoverable(false, ok.deps)).toBe('ok');
    expect(ok.saved).toEqual([{ username: 'alice_7', claimedAt: 1, discoverable: false }]);
    const refused = fakeUsernameDeps({ setUsernameDiscoverable: async () => { throw REFUSAL(); } }, held);
    expect(await accountsUsername.setUsernameDiscoverable(false, refused.deps)).toBe('refused');
    expect(refused.saved).toEqual([]);
  });

  it('unlink clears the local row on success only', async () => {
    const held = { username: 'alice_7', claimedAt: 1, discoverable: true };
    const ok = fakeUsernameDeps({}, held);
    expect(await accountsUsername.unlinkUsername(ok.deps)).toBe('ok');
    expect(ok.cleared).toHaveLength(1);
    const failed = fakeUsernameDeps({ usernameUnlink: async () => { throw TRANSPORT(); } }, held);
    expect(await accountsUsername.unlinkUsername(failed.deps)).toBe('failed');
    expect(failed.cleared).toHaveLength(0);
  });

  it('search: invalid before the wire; every server refusal is no_match; a hit resolves the anchor; a reserved name is a legal lookup', async () => {
    const invalid = fakeUsernameDeps();
    expect(await accountsUsername.discoverySearchByUsername('ab', invalid.deps)).toEqual({ outcome: 'invalid' });
    expect(invalid.apiCalls).toEqual([]);
    const refused = fakeUsernameDeps({ discoveryLookupUsername: async () => { throw REFUSAL(); } });
    expect(await accountsUsername.discoverySearchByUsername('Alice_7', refused.deps)).toEqual({ outcome: 'no_match' });
    const found = fakeUsernameDeps();
    expect(await accountsUsername.discoverySearchByUsername(' Alice_7 ', found.deps)).toEqual({
      outcome: 'found',
      anchor: ANCHOR,
      deviceCount: 1,
    });
    expect(found.apiCalls).toEqual([['discoveryLookupUsername', ['bearer', 'alice_7']]]);
    const reservedSent: unknown[][] = [];
    const reservedLookup = fakeUsernameDeps({
      discoveryLookupUsername: async (...args: unknown[]) => {
        reservedSent.push(args);
        throw REFUSAL();
      },
    });
    expect(await accountsUsername.discoverySearchByUsername('admin', reservedLookup.deps)).toEqual({ outcome: 'no_match' });
    expect(reservedSent).toEqual([['bearer', 'admin']]);
    const errored = fakeUsernameDeps({ discoveryLookupUsername: async () => { throw TRANSPORT(); } });
    expect(await accountsUsername.discoverySearchByUsername('alice_7', errored.deps)).toEqual({ outcome: 'error' });
  });
});

/* ── 5. the row, on the recorded fake ───────────────────────────────── */

interface FakeDb {
  name: string;
  execute: jest.Mock;
  close: jest.Mock;
}
const sqlite = jest.requireMock('@op-engineering/op-sqlite') as {
  open: (o: { name: string }) => FakeDb;
  __sqlite: { opened: string[]; instances: Map<string, FakeDb>; reset: () => void };
};

describe('the username row (db.ts kind = "username", the per-class shape)', () => {
  beforeEach(async () => {
    await db.close();
    db.setWorkspace('real');
    sqlite.__sqlite.reset();
    await db.initDb();
  });
  afterEach(async () => {
    await db.close();
  });

  const statements = (name = 'tacendum.sqlite') =>
    (sqlite.__sqlite.instances.get(name)?.execute.mock.calls ?? []).map(c => [String(c[0]), c[1] as unknown[]] as const);

  it('the kind is spelled once, and the provenance mark is a server introduction', () => {
    expect(db.USERNAME_KIND).toBe('username');
    expect(db.DISCOVERY_USERNAME_INTRODUCED).toBe('discovery-username');
    expect(db.serverIntroduced(db.DISCOVERY_USERNAME_INTRODUCED)).toBe(true);
    expect(db.DB_TABLES).toContain('username_notice');
    expect(db.DB_TABLES).toContain('account_identifier');
  });

  it('save writes the kind row with pending NULL and restoredAt NULL; clear deletes THAT kind alone', async () => {
    await db.saveUsernameIdentifier({ username: 'alice_7', claimedAt: 123, discoverable: true });
    const insert = statements().find(([sql]) => sql.includes('INSERT OR REPLACE INTO account_identifier'));
    expect(insert).toBeDefined();
    // The eighth value is the server's stamp (the proof pass, 2026-10-08):
    // NULL until the screen adopts the live row's.
    expect(insert![1]).toEqual(['username', 'alice_7', 123, 1, null, null, null, null]);
    await db.clearUsernameIdentifier();
    const del = statements().find(([sql]) => sql.includes('DELETE FROM account_identifier WHERE kind = ?'));
    expect(del![1]).toEqual(['username']);
  });

  it('the notice row: save / clear on its own table', async () => {
    await db.saveUsernameNotice({ receivedAt: 777 });
    const insert = statements().find(([sql]) => sql.includes('INSERT OR REPLACE INTO username_notice'));
    expect(insert![1]).toEqual([777]);
    await db.clearUsernameNotice();
    expect(statements().some(([sql]) => sql === 'DELETE FROM username_notice')).toBe(true);
  });
});

/* ── 6. the migration, on the real engine ───────────────────────────── */

type Row = Record<string, unknown>;
interface Engine {
  prepare(sql: string): { all(...args: unknown[]): Row[]; run(...args: unknown[]): unknown };
  exec(sql: string): void;
  close(): void;
}
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (p: string) => Engine };

function bindRealEngine(engine: Engine): void {
  const instance = sqlite.open({ name: 'tacendum.sqlite' });
  instance.execute.mockImplementation(async (sql: unknown, params?: unknown[]) => {
    const args = (params ?? []).map(p => (p === undefined ? null : p));
    const rows = engine.prepare(String(sql)).all(...args);
    const changes = engine.prepare('SELECT changes() AS c').all()[0]!.c as number;
    return { rows, rowsAffected: changes };
  });
}

describe('the CHECK-widening migration, on the real engine', () => {
  let engine: Engine;
  afterEach(async () => {
    await db.close();
    engine.close();
  });

  const dump = (): Row[] =>
    engine
      .prepare('SELECT kind, value, verifiedAt, discoverable, pendingValue, pendingRequestedAt, restoredAt FROM account_identifier ORDER BY kind')
      .all();
  const ddl = (table: string): string =>
    engine.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).all(table)[0]!.sql as string;

  it('an earlier-era file: both landed rows carried raw-equal, the CHECK widened, a username row then accepted; idempotent', async () => {
    await db.close();
    sqlite.__sqlite.reset();
    engine = new DatabaseSync(':memory:');
    engine.exec(`
      CREATE TABLE account_identifier (
        kind TEXT PRIMARY KEY CHECK (kind IN ('email','phone')),
        value TEXT, verifiedAt INTEGER, discoverable INTEGER NOT NULL DEFAULT 0,
        pendingValue TEXT, pendingRequestedAt INTEGER, restoredAt INTEGER
      );
      INSERT INTO account_identifier VALUES ('email', 'alice@example.com', 111, 1, NULL, NULL, NULL);
      INSERT INTO account_identifier VALUES ('phone', '+15555550100', 222, 0, '+15555550199', 333, 444);
    `);
    expect(() => engine.prepare(`INSERT INTO account_identifier (kind) VALUES ('username')`).run()).toThrow();
    const before = dump();
    bindRealEngine(engine);
    db.setWorkspace('real');
    await db.initDb();
    expect(dump()).toEqual(before);
    expect(ddl('account_identifier')).toContain("'username'");
    await db.saveUsernameIdentifier({ username: 'alice_7', claimedAt: 555, discoverable: false });
    expect(await db.loadUsernameIdentifier()).toEqual({ username: 'alice_7', claimedAt: 555, discoverable: false, since: null });
    expect(dump()).toHaveLength(3);
    // The other classes still read raw-equal through their own readers.
    expect((await db.loadAccountIdentifier())!.email).toBe('alice@example.com');
    expect((await db.loadPhoneIdentifier())!.pendingPhone).toBe('+15555550199');
    // Idempotent: a second boot rebuilds nothing and loses nothing.
    const afterFirst = dump();
    const ddlFirst = ddl('account_identifier');
    await db.close();
    await db.initDb();
    expect(dump()).toEqual(afterFirst);
    expect(ddl('account_identifier')).toBe(ddlFirst);
    expect(engine.prepare(`SELECT name FROM sqlite_master WHERE name LIKE 'account_identifier_%'`).all()).toEqual([]);
  });

  it('recovery_local still REFUSES kind = username — the recovery exclusion is structural on this device', async () => {
    await db.close();
    sqlite.__sqlite.reset();
    engine = new DatabaseSync(':memory:');
    bindRealEngine(engine);
    db.setWorkspace('real');
    await db.initDb();
    expect(ddl('recovery_local')).not.toContain("'username'");
    await expect(
      db.saveLocalRecovery({ kind: 'username', value: 'alice_7', groupId: GROUP, completesAt: 1, verifiedAt: 1 }),
    ).rejects.toThrow();
    // …while the identifier row takes it, on a fresh file, without any migration.
    await db.saveUsernameIdentifier({ username: 'alice_7', claimedAt: 1, discoverable: true });
    expect((await db.loadUsernameIdentifier())?.username).toBe('alice_7');
    // And clearing it leaves the other classes untouched.
    await db.savePhoneIdentifier({ phone: '+15555550100', verifiedAt: 2, discoverable: true, pendingPhone: null, pendingRequestedAt: null, restoredAt: null });
    await db.clearUsernameIdentifier();
    expect(await db.loadUsernameIdentifier()).toBeNull();
    expect((await db.loadPhoneIdentifier())?.phone).toBe('+15555550100');
  });
});

/* ── 7. duress ──────────────────────────────────────────────────────── */

describe('duress (the duress rule at the api chokepoint; the row in the workspace-scoped store)', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('every username call throws a transport-shaped error, never an ApiRequestError, and fetch is never reached', async () => {
    const fetchSpy = jest.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    session.setMode('duress');
    for (const call of [
      () => api.apiClaimUsername('tok', 'alice_7', true),
      () => api.apiRenameUsername('tok', 'alice_7', true),
      () => api.apiUnlinkUsername('tok'),
      () => api.apiSetUsernameDiscoverable('tok', true),
      () => api.apiDiscoveryLookupUsername('tok', 'alice_7'),
      () => api.apiUsernameEligibility('tok'),
    ]) {
      await expect(call()).rejects.toThrow(TypeError);
      await expect(call()).rejects.not.toBeInstanceOf(ApiRequestError);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('through the module, a duress session answers failed and writes nothing — indistinguishable from offline', async () => {
    globalThis.fetch = jest.fn() as unknown as typeof fetch;
    session.setMode('duress');
    const { deps, saved, cleared } = fakeUsernameDeps({
      usernameClaim: api.apiClaimUsername,
      usernameUnlink: api.apiUnlinkUsername,
      discoveryLookupUsername: api.apiDiscoveryLookupUsername,
    });
    expect(await accountsUsername.claimUsername('alice_7', true, deps)).toBe('failed');
    expect(await accountsUsername.unlinkUsername(deps)).toBe('failed');
    expect(await accountsUsername.discoverySearchByUsername('alice_7', deps)).toEqual({ outcome: 'error' });
    expect(saved).toEqual([]);
    expect(cleared).toEqual([]);
  });

  it('with the decoy workspace active, the row and the notice land in the DECOY file and never touch the real one', async () => {
    await db.close();
    sqlite.__sqlite.reset();
    db.setWorkspace('decoy');
    await db.initDb();
    await db.saveUsernameIdentifier({ username: 'alice_7', claimedAt: 1, discoverable: true });
    await db.saveUsernameNotice({ receivedAt: 2 });
    expect(sqlite.__sqlite.opened).toEqual(['tacendum-decoy.sqlite']);
    expect(sqlite.__sqlite.instances.has('tacendum.sqlite')).toBe(false);
    const decoy = sqlite.__sqlite.instances.get('tacendum-decoy.sqlite')!;
    const sqls = decoy.execute.mock.calls.map(c => String(c[0]));
    expect(sqls.some(s => s.includes('INSERT OR REPLACE INTO account_identifier'))).toBe(true);
    expect(sqls.some(s => s.includes('INSERT OR REPLACE INTO username_notice'))).toBe(true);
    await db.close();
    db.setWorkspace('real');
  });
});

/* ── 8. notices ─────────────────────────────────────────────────────── */

function linkingFake(): {
  deps: LinkingDeps;
  cleared: number[];
  notices: db.UsernameNoticeRow[];
  recovery: db.RecoveryNoticeRow[];
} {
  const cleared: number[] = [];
  const notices: db.UsernameNoticeRow[] = [];
  const recovery: db.RecoveryNoticeRow[] = [];
  const deps: LinkingDeps = {
    api: {
      getPrekeyBundle: async () => {
        throw new Error('not in this suite');
      },
      linkOfferInit: async () => {
        throw new Error('not in this suite');
      },
      linkOfferSubmit: async () => undefined,
      linkAccept: async () => undefined,
      rosterMutation: async () => undefined,
    },
    crypto: {
      processPreKeyBundle: async () => undefined,
      safetyNumber: async () => null,
      signLinkOp: async () => 'sig',
      verifyLinkOp: async () => true,
      identityPublicKey: async () => 'OWNKEY',
    },
    db: {
      loadLinkGroup: async () => null,
      saveLinkGroup: async () => undefined,
      upsertLinkedDevice: async () => undefined,
      markLinkedDeviceState: async () => undefined,
      listLinkedDevices: async () => [],
      clearLinkGroup: async () => undefined,
      savePendingLinkOffer: async () => undefined,
      loadPendingLinkOffer: async () => null,
      deletePendingLinkOffer: async () => undefined,
      savePendingLinkCeremony: async () => undefined,
      loadPendingLinkCeremony: async () => null,
      deletePendingLinkCeremony: async () => undefined,
      pristineForLink: async () => true,
      savePendingLinkMutation: async () => undefined,
      listPendingLinkMutations: async () => [],
      deletePendingLinkMutation: async () => undefined,
      listSiblingAgents: async () => [],
      saveRecoveryNotice: async row => {
        recovery.push({ ...row });
      },
      loadRecoveryNotice: async () => recovery[recovery.length - 1] ?? null,
      clearUsernameIdentifier: async () => {
        cleared.push(1);
      },
      saveUsernameNotice: async row => {
        notices.push({ ...row });
      },
    },
    token: async () => 'bearer',
    selfId: async () => SELF,
    now: () => NOW_MS,
    freshNonce: () => '01HQNNNN00000000000000000N',
  };
  return { deps, cleared, notices, recovery };
}

const frame = (payload: object): AccountsNoticeFrame => ({
  type: 'accounts',
  msgId: '01HQMSGZ00000000000000000M',
  from: OTHER,
  payload: b64(JSON.stringify(payload)),
  ts: NOW_MS,
});

describe('notices: the tolerant-unknown-kind fallback and usernameRevoked (client half)', () => {
  it('a well-formed notice of a FUTURE kind is IGNORED — acked, nothing applied, nothing stored, never a parse failure', async () => {
    const { deps, cleared, notices, recovery } = linkingFake();
    expect(
      await handleAccountsNoticeFrame(frame({ kind: 'somethingFromNextYear', groupId: GROUP, extra: 1 }), deps),
    ).toBe('ignored');
    expect(cleared).toEqual([]);
    expect(notices).toEqual([]);
    expect(recovery).toEqual([]);
  });

  it('a KNOWN kind with a malformed body still drops; garbage still drops', async () => {
    const { deps } = linkingFake();
    expect(await handleAccountsNoticeFrame(frame({ kind: 'recoveryRequested', groupId: GROUP }), deps)).toBe('dropped');
    expect(await handleAccountsNoticeFrame(frame({}), deps)).toBe('dropped');
    expect(await handleAccountsNoticeFrame({ ...frame({}), payload: '!!!not base64' }, deps)).toBe('dropped');
  });

  it('usernameRevoked: stored — the local row cleared, the notice recorded at receipt time, the listener fired', async () => {
    const { deps, cleared, notices } = linkingFake();
    const fired: number[] = [];
    const off = onUsernameNotice(() => fired.push(1));
    try {
      expect(await handleAccountsNoticeFrame(frame({ kind: 'usernameRevoked' }), deps)).toBe('stored');
    } finally {
      off();
    }
    expect(cleared).toEqual([1]);
    expect(notices).toEqual([{ receivedAt: NOW_MS }]);
    expect(fired).toEqual([1]);
  });

  it('a reason riding the wire never surfaces: the union strips it and the stored row holds only when', async () => {
    const { deps, notices } = linkingFake();
    expect(await handleAccountsNoticeFrame(frame({ kind: 'usernameRevoked', reason: 'impersonation' }), deps)).toBe('stored');
    expect(notices).toEqual([{ receivedAt: NOW_MS }]);
    expect(AccountsNotice.parse({ kind: 'usernameRevoked', reason: 'x' })).toEqual({ kind: 'usernameRevoked' });
  });

  it('the landed kinds still parse through the tolerant path exactly as before (recoveryRequested stores)', async () => {
    const { deps, recovery } = linkingFake();
    const completes = Math.floor(NOW_MS / 1000) + 72 * 3600;
    expect(
      await handleAccountsNoticeFrame(
        frame({ kind: 'recoveryRequested', groupId: GROUP, class: 'phone', completesAt: completes }),
        deps,
      ),
    ).toBe('stored');
    expect(recovery).toHaveLength(1);
  });
});

/* ── 9. provenance ──────────────────────────────────────────────── */

describe('startDiscoveredChat provenance (designed open — the username class wired)', () => {
  function accountsFake() {
    const apiCalls: string[] = [];
    const upserts: unknown[][] = [];
    const record = <T,>(name: string, answer: T) => async (): Promise<T> => {
      apiCalls.push(name);
      return answer;
    };
    const deps: accounts.AccountsDeps = {
      api: {
        emailRequestCode: record('emailRequestCode', undefined),
        emailVerify: record('emailVerify', undefined),
        emailUnlink: record('emailUnlink', undefined),
        setDiscoverable: record('setDiscoverable', undefined),
        discoveryLookup: record('discoveryLookup', { members: [], rosterVersion: 1 }),
        recoveryRequestCode: record('recoveryRequestCode', undefined),
        recoveryVerify: record('recoveryVerify', { groupId: GROUP, completesAt: 0 }),
        recoveryRequestCodePhone: record('recoveryRequestCodePhone', undefined),
        recoveryVerifyPhone: record('recoveryVerifyPhone', { groupId: GROUP, completesAt: 0 }),
        recoveryCancel: record('recoveryCancel', undefined),
        recoveryComplete: record('recoveryComplete', undefined),
        authChallenge: record('authChallenge', { challenge: 'AAAA' }),
        getPrekeyBundle: async () => {
          throw new Error('not served');
        },
      },
      crypto: { identityPublicKey: async () => 'IDKEY', signAuthChallenge: async c => c },
      db: {
        loadAccountIdentifier: async () => null,
        saveAccountIdentifier: async () => undefined,
        clearAccountIdentifier: async () => undefined,
        savePhoneIdentifier: async () => undefined,
        clearPhoneIdentifier: async () => undefined,
        loadLocalRecovery: async () => null,
        saveLocalRecovery: async () => undefined,
        clearLocalRecovery: async () => undefined,
        saveRecoveryNotice: async () => undefined,
        loadRecoveryNotice: async () => null,
        upsertChat: async (...args: unknown[]) => {
          upserts.push(args);
        },
        setLocalName: async () => undefined,
        loadLinkGroup: async () => null,
        saveLinkGroup: async () => undefined,
        upsertLinkedDevice: async () => undefined,
      },
      dissolve: async () => undefined,
      token: async () => 'bearer',
      selfId: async () => SELF,
      now: () => NOW_MS,
    };
    return { deps, apiCalls, upserts };
  }

  it("records 'discovery-username' when told to, and the mark is a server introduction", async () => {
    const { deps, apiCalls, upserts } = accountsFake();
    await accounts.startDiscoveredChat('alice_7', ANCHOR, deps, db.DISCOVERY_USERNAME_INTRODUCED);
    expect(upserts).toEqual([[ANCHOR, undefined, 'discovery-username']]);
    expect(db.serverIntroduced(upserts[0]![2] as string)).toBe(true);
    expect(apiCalls).toEqual([]);
  });

  it("records 'discovery' by default — the shipped email/phone bytes, unchanged", async () => {
    const { deps, upserts } = accountsFake();
    await accounts.startDiscoveredChat('alice@example.com', ANCHOR, deps);
    expect(upserts).toEqual([[ANCHOR, undefined, 'discovery']]);
  });
});

/* ── 10. the pin, both ways: the api spy ────────────────────────────── */

/** The six username wire functions under spy, and a fetch that records every
 * path and body and refuses everything with the collapsed 403. */
function armWireSpies(): {
  spies: jest.SpyInstance[];
  paths: string[];
  bodies: string[];
  restore: () => void;
} {
  const spies = [
    jest.spyOn(api, 'apiClaimUsername'),
    jest.spyOn(api, 'apiRenameUsername'),
    jest.spyOn(api, 'apiUnlinkUsername'),
    jest.spyOn(api, 'apiSetUsernameDiscoverable'),
    jest.spyOn(api, 'apiDiscoveryLookupUsername'),
    jest.spyOn(api, 'apiUsernameEligibility'),
  ];
  const paths: string[] = [];
  const bodies: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = jest.fn(async (url: unknown, init?: { body?: unknown }) => {
    const path = String(url);
    paths.push(path);
    bodies.push(typeof init?.body === 'string' ? init.body : '');
    if (path.endsWith('/v1/identifiers/username/eligibility')) {
      return { ok: true, status: 200, json: async () => ({ hasVerifiedIdentifier: true }) };
    }
    return { ok: false, status: 403, json: async () => ({ error: { code: 'accounts_refused', detail: 'x' } }) };
  }) as unknown as typeof fetch;
  return {
    spies,
    paths,
    bodies,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

describe('with USERNAME_UI_ENABLED off (the module mock — every binary through build 22), the api spy shows ZERO username calls', () => {
  it('the landed find flow, driven end to end, never reaches a username wire function', async () => {
    mockUsernameUiEnabled = false;
    const wire = armWireSpies();
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(null);
    jest.spyOn(db, 'loadPhoneIdentifier').mockResolvedValue(null);
    jest.spyOn(accounts, 'discoverySearch').mockResolvedValue({ outcome: 'no_match' });
    try {
      const tree = await render(<DiscoveryScreen onBack={jest.fn()} onOpenChat={jest.fn()} />);
      await type(tree, 'alice@example.com');
      await press(tree, 'discovery-search');
      const rendered = JSON.stringify(tree.toJSON());
      // No username class entry, no username wording, no @-less name field.
      expect(rendered.toLowerCase().includes('username')).toBe(false);
      expect(tree.root.findAllByProps({ testID: 'discovery-class-username' })).toHaveLength(0);
      tree.unmount();
    } finally {
      wire.restore();
    }
    for (const spy of wire.spies) expect(spy).not.toHaveBeenCalled();
    expect(wire.paths.filter(p => p.includes('/username'))).toEqual([]);
    expect(wire.bodies.filter(b => b.includes('username'))).toEqual([]);
  });
});

describe('with USERNAME_UI_ENABLED on (build 23, the shipped value), the find-by-name chip drives exactly the lookup call', () => {
  it('the chip renders, the typed handle rides the shared lookup route as the {username} field, and no lifecycle call is made', async () => {
    mockUsernameUiEnabled = true;
    const wire = armWireSpies();
    jest.spyOn(reauth, 'currentToken').mockResolvedValue('bearer');
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(null);
    jest.spyOn(db, 'loadPhoneIdentifier').mockResolvedValue(null);
    const emailSearch = jest.spyOn(accounts, 'discoverySearch').mockResolvedValue({ outcome: 'no_match' });
    try {
      const tree = await render(<DiscoveryScreen onBack={jest.fn()} onOpenChat={jest.fn()} />);
      expect(tree.root.findAllByProps({ testID: 'discovery-class-username' }).length).toBeGreaterThan(0);
      await press(tree, 'discovery-class-username');
      await type(tree, 'alice_7');
      await press(tree, 'discovery-search');
      tree.unmount();
    } finally {
      wire.restore();
    }
    // One caller-owned eligibility read precedes the target lookup. No
    // lifecycle verb or email lookup runs.
    expect(wire.spies[4]).toHaveBeenCalledTimes(1);
    expect(wire.spies[4]).toHaveBeenCalledWith('bearer', 'alice_7');
    expect(wire.spies[5]).toHaveBeenCalledTimes(1);
    expect(wire.spies[5]).toHaveBeenCalledWith('bearer');
    for (const spy of wire.spies.slice(0, 4)) expect(spy).not.toHaveBeenCalled();
    expect(emailSearch).not.toHaveBeenCalled();
    expect(wire.paths.filter(p => p.endsWith('/v1/discovery/lookup'))).toHaveLength(1);
    expect(wire.paths.filter(p => p.endsWith('/v1/identifiers/username/eligibility'))).toHaveLength(1);
    expect(wire.bodies).toEqual(['', JSON.stringify({ username: 'alice_7' })]);
  });
});

/* ── 11. fix/username-discovery (2026-10-08): U3, U4, D1/D3 ──────────── */

const STATE_ELIGIBLE: accountsUsername.IdentifierState = {
  source: 'state',
  eligibility: 'eligible',
  holdsUsername: null,
  emailLinked: null,
  phoneLinked: null,
  cooldownUntil: null,
  usernameSince: null,
  emailSince: null,
  usernameFindable: null,
  emailFindable: null,
};
const stateOf = (
  partial: Partial<accountsUsername.IdentifierState>,
): accountsUsername.IdentifierState => ({ ...STATE_ELIGIBLE, ...partial });

function stubScreenRows(row: db.UsernameIdentifierRow | null = null): void {
  jest.spyOn(db, 'loadUsernameIdentifier').mockResolvedValue(row);
  jest.spyOn(db, 'loadUsernameNotice').mockResolvedValue(null);
  jest.spyOn(db, 'loadUsernameUnlink').mockResolvedValue(null);
  jest.spyOn(db, 'loadUsernameCooldown').mockResolvedValue(null);
}

const has = (tree: ReactTestRenderer.ReactTestRenderer, testID: string): boolean =>
  tree.root.findAllByProps({ testID }).length > 0;
const rendered = (tree: ReactTestRenderer.ReactTestRenderer): string =>
  JSON.stringify(tree.toJSON());
const submitDisabled = (tree: ReactTestRenderer.ReactTestRenderer): boolean =>
  tree.root
    .findAllByProps({ testID: 'account-username-submit' })
    .find(n => n.props.disabled !== undefined)!.props.disabled === true;

describe('U3: a refused state read is not a connection problem', () => {
  beforeEach(() => {
    accountsUsername.invalidateIdentifierState();
    accountsUsername.clearIdentifierRoutePacing();
  });

  it('a 403 renders the neutral sentence, a network error renders the connection sentence, and Retry rechecks each time', async () => {
    stubScreenRows();
    jest
      .spyOn(accountsUsername, 'getIdentifierState')
      .mockResolvedValueOnce(stateOf({ eligibility: 'refused' }))
      .mockResolvedValueOnce(stateOf({ eligibility: 'failed' }))
      .mockResolvedValue(stateOf({}));
    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    expect(has(tree, 'account-username-eligibility-refused')).toBe(true);
    expect(rendered(tree)).toContain(ACCOUNTS_USERNAME_COPY.eligibilityRefused);
    expect(rendered(tree)).not.toContain(ACCOUNTS_USERNAME_COPY.eligibilityUnavailable);
    await type(tree, 'alice_7');
    expect(submitDisabled(tree)).toBe(true);
    await press(tree, 'account-username-eligibility-retry');
    expect(has(tree, 'account-username-eligibility-refused')).toBe(false);
    expect(has(tree, 'account-username-eligibility-unavailable')).toBe(true);
    expect(rendered(tree)).toContain(ACCOUNTS_USERNAME_COPY.eligibilityUnavailable);
    expect(submitDisabled(tree)).toBe(true);
    await press(tree, 'account-username-eligibility-retry');
    expect(has(tree, 'account-username-eligibility-unavailable')).toBe(false);
    expect(submitDisabled(tree)).toBe(false);
    tree.unmount();
  });

  it('the neutral sentence blames nothing and the connection sentence is the build-33 bytes', () => {
    expect(ACCOUNTS_USERNAME_COPY.eligibilityRefused).toBe(
      'Tacendum could not check username access right now. Try again in a minute.',
    );
    expect(ACCOUNTS_USERNAME_COPY.eligibilityRefused.toLowerCase()).not.toMatch(
      /connection|network|offline|limit|budget|too many|quota/,
    );
    expect(ACCOUNTS_USERNAME_COPY.eligibilityUnavailable).toBe(
      'Could not check username access. Check your connection and try again.',
    );
  });

  it('pacing: the first ten identifier-route calls in a minute are never paced; the eleventh says how long; the window slides', () => {
    expect(accountsUsername.IDENTIFIER_ROUTE_CALLS_PER_MINUTE).toBe(10);
    expect(accountsUsername.identifierRoutePacing(NOW_MS)).toBeNull();
    for (let i = 0; i < 10; i++) {
      expect(accountsUsername.identifierRoutePacing(NOW_MS + i * 1000)).toBeNull();
      accountsUsername.noteIdentifierRouteCall(NOW_MS + i * 1000);
    }
    // The eleventh, 10 s after the first: the first expires 50 s from now.
    expect(accountsUsername.identifierRoutePacing(NOW_MS + 10_000)).toBe(50);
    expect(accountsUsername.identifierRoutePacing(NOW_MS + 59_999)).toBe(1);
    // The first call is a minute old: one slot is free again.
    expect(accountsUsername.identifierRoutePacing(NOW_MS + 60_000)).toBeNull();
    accountsUsername.noteIdentifierRouteCall(NOW_MS + 60_000);
    expect(accountsUsername.identifierRoutePacing(NOW_MS + 60_000)).toBe(1);
  });

  it('the module notes its own wire calls — claim, rename, unlink, the toggle — so the screen can pace before the eleventh', async () => {
    const held = { username: 'alice_7', claimedAt: 1, discoverable: true };
    const { deps } = fakeUsernameDeps({}, held);
    deps.now = () => NOW_MS;
    for (let i = 0; i < 4; i++) {
      await accountsUsername.claimUsername(`alice_${i}`, true, deps);
      await accountsUsername.setUsernameDiscoverable(true, deps);
    }
    expect(accountsUsername.identifierRoutePacing(NOW_MS)).toBeNull();
    await accountsUsername.unlinkUsername(deps);
    expect(accountsUsername.identifierRoutePacing(NOW_MS)).toBeNull();
    await accountsUsername.claimUsername('alice_9', true, deps);
    expect(accountsUsername.identifierRoutePacing(NOW_MS)).toBe(60);
    // A local refusal spends nothing and is never counted.
    accountsUsername.clearIdentifierRoutePacing();
    await accountsUsername.claimUsername('admin', true, deps);
    await accountsUsername.claimUsername('ab', true, deps);
    expect(accountsUsername.identifierRoutePacing(NOW_MS)).toBeNull();
  });

  it('the screen says "Try again in N s" BEFORE sending when this device is at the budget — and never for a first call', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW_MS);
    stubScreenRows({ username: 'alice_7', claimedAt: 1, discoverable: true });
    jest.spyOn(accountsUsername, 'getIdentifierState').mockResolvedValue(stateOf({ holdsUsername: true }));
    const claim = jest.spyOn(accountsUsername, 'claimUsername').mockResolvedValue('renamed');
    for (let i = 0; i < 10; i++) accountsUsername.noteIdentifierRouteCall(NOW_MS - 30_000);
    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    await press(tree, 'account-username-rename');
    await type(tree, 'alice_8');
    await press(tree, 'account-username-submit');
    expect(claim).not.toHaveBeenCalled();
    expect(rendered(tree)).toContain(ACCOUNTS_USERNAME_COPY.paced(30));
    expect(ACCOUNTS_USERNAME_COPY.paced(30)).toBe('Try again in 30 s.');
    tree.unmount();
    // Half a minute later the oldest calls have aged out: the tap goes through.
    accountsUsername.clearIdentifierRoutePacing();
    const again = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    await press(again, 'account-username-rename');
    await type(again, 'alice_8');
    await press(again, 'account-username-submit');
    expect(claim).toHaveBeenCalledWith('alice_8', true);
    again.unmount();
  });
});

describe('U4: renaming to the name already held is answered locally', () => {
  it('the module answers "same" for the held name — case-folded, trimmed — without a wire call and without spending an attempt', async () => {
    const held = { username: 'alice_7', claimedAt: 1, discoverable: true };
    const { deps, saved, apiCalls } = fakeUsernameDeps({}, held);
    expect(await accountsUsername.claimUsername(' Alice_7 ', true, deps)).toBe('same');
    expect(await accountsUsername.claimUsername('alice_7', false, deps)).toBe('same');
    expect(apiCalls).toEqual([]);
    expect(saved).toEqual([]);
    expect(ACCOUNTS_USERNAME_COPY.sameName).toBe('That is already your username.');
  });
});

describe('D1/D3: the username deck’s miss lead names the self-miss and the shared daily budget', () => {
  it('says that searching for your own email or username always misses, from any device, and that the day’s searches are shared and reset at midnight UTC', () => {
    expect(ACCOUNTS_USERNAME_COPY.startChatMissInfoLead).toContain(
      'Searching for your own email or username, from any of your devices, always shows no match.',
    );
    expect(ACCOUNTS_USERNAME_COPY.startChatMissInfoLead).toContain('shared by your linked devices');
    expect(ACCOUNTS_USERNAME_COPY.startChatMissInfoLead).toContain('midnight UTC');
    expect(ACCOUNTS_USERNAME_COPY.startChatMissInfoLead).toMatch(/^A miss can mean/);
  });
});
