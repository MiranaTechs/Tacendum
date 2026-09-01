/**
 * THE REGULAR-FOLKS DISCOVERY FLOW — the three
 * properties this phase's Verify names, each asserted against the real
 * screens and the real state machine:
 *
 *  1. DISCOVERABILITY DEFAULTS OFF for a freshly verified identifier — the
 *     toggle's INITIAL STATE is asserted (the Switch's `value`), not the
 *     copy, and the state machine records `discoverable: false` at the
 *     verify moment with no code path to ON without the owner's own later
 *     toggle (consent belongs to the discovered party).
 *
 *  2. THE RESULT CARD IS LABELED WITH THE TYPED EMAIL AND NEVER A ULID —
 *     a regex over the entire rendered tree: no 26-character
 *     Crockford-ULID token reaches glass anywhere in the find flow. The
 *     anchor the lookup resolved is an API fact that flows into the
 *     ordinary chat-open path unrendered. And EVERY refusal is one
 *     outcome, indistinguishable BY DESIGN: the collapsed miss, the
 *     non-discoverable hit, and the spent budget produce deep-equal
 *     module answers and the SAME rendered sentence.
 *
 *  3. REGISTRATION CONTAINS ZERO IDENTIFIER FIELDS (structurally): the register screen renders NO text input of any
 *     kind, while the recovery door lives BESIDE it on the landing
 *     surface — its own route, its own screen.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { TextInput } from 'react-native';
import { ApiRequestError } from '../src/api';
import * as accounts from '../src/accounts';
import { ACCOUNTS_COPY } from '../src/accountsCopy';
import * as accountsPhone from '../src/accountsPhone';
import * as db from '../src/db';
import { AccountEmailScreen } from '../src/screens/AccountEmailScreen';
import { DiscoveryScreen } from '../src/screens/DiscoveryScreen';
import { LandingScreen } from '../src/screens/LandingScreen';
import { RegisterScreen } from '../src/screens/RegisterScreen';

jest.mock('../src/registration', () => ({
  createOrRestoreAccount: jest.fn(),
}));

/** The Crockford ULID shape (no I, L, O, U — 26 chars): what must never
 * appear in the discovery flow's rendered tree. */
const ULID_RE = /[0-9A-HJKMNP-TV-Z]{26}/;

const ANCHOR = '01HQZZZZ00000000000000000A';

function fakeAccountsDeps(
  overrides: Partial<{
    lookup: (token: string, email: string) => Promise<{ members: Array<{ userId: string; class: 'phone' | 'tablet' | 'desktop' }>; rosterVersion: number }>;
    verify: (token: string, email: string, code: string) => Promise<void>;
  }> = {},
): { deps: accounts.AccountsDeps; saved: db.AccountIdentifierRow[] } {
  const saved: db.AccountIdentifierRow[] = [];
  const deps: accounts.AccountsDeps = {
    api: {
      emailRequestCode: async () => undefined,
      emailVerify: overrides.verify ?? (async () => undefined),
      emailUnlink: async () => undefined,
      setDiscoverable: async () => undefined,
      discoveryLookup:
        (overrides.lookup as accounts.AccountsDeps['api']['discoveryLookup']) ??
        (async () => ({ members: [{ userId: ANCHOR, class: 'phone' }], rosterVersion: 1 })),
      recoveryRequestCode: async () => undefined,
      recoveryVerify: async () => ({ groupId: ANCHOR, completesAt: 0 }),
      recoveryRequestCodePhone: async () => undefined,
      recoveryVerifyPhone: async () => ({ groupId: ANCHOR, completesAt: 0 }),
      recoveryCancel: async () => undefined,
      recoveryComplete: async () => undefined,
      authChallenge: async () => ({ challenge: 'AAAA' }),
      getPrekeyBundle: async () => {
        throw new Error('not served in this suite');
      },
    },
    crypto: {
      identityPublicKey: async () => 'IDKEY',
      signAuthChallenge: async c => `sig(${c})`,
    },
    db: {
      loadAccountIdentifier: async () => saved[saved.length - 1] ?? null,
      saveAccountIdentifier: async row => {
        saved.push({ ...row });
      },
      clearAccountIdentifier: async () => undefined,
      savePhoneIdentifier: async () => undefined,
      clearPhoneIdentifier: async () => undefined,
      loadLocalRecovery: async () => null,
      saveLocalRecovery: async () => undefined,
      clearLocalRecovery: async () => undefined,
      saveRecoveryNotice: async () => undefined,
      loadRecoveryNotice: async () => null,
      upsertChat: async () => undefined,
      setLocalName: async () => undefined,
      loadLinkGroup: async () => null,
      saveLinkGroup: async () => undefined,
      upsertLinkedDevice: async () => undefined,
    },
    dissolve: async () => undefined,
    token: async () => 'bearer',
    selfId: async () => '01HQSELF000000000000000000',
    now: () => 1_756_000_000_000,
  };
  return { deps, saved };
}

async function render(el: React.ReactElement): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(el);
  });
  return tree;
}

afterEach(() => {
  jest.restoreAllMocks();
});

/* ── 1. default OFF ────────────────────────────────────────────────── */

describe('discoverability defaults OFF for a freshly verified identifier', () => {
  it('the state machine records discoverable: false at the verify moment', async () => {
    const { deps, saved } = fakeAccountsDeps();
    const outcome = await accounts.confirmAttach('Alice@Example.com', '123456', deps);
    expect(outcome).toBe('attached');
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      email: 'alice@example.com',
      discoverable: false,
    });
  });

  it('a REFUSED verify records nothing — refusal-first', async () => {
    const { deps, saved } = fakeAccountsDeps({
      verify: async () => {
        throw new ApiRequestError('refused', 403, 'accounts_refused');
      },
    });
    const outcome = await accounts.confirmAttach('alice@example.com', '000000', deps);
    expect(outcome).toBe('refused');
    expect(saved).toHaveLength(0);
  });

  it("the toggle's INITIAL state is off on the settings surface", async () => {
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue({
      email: 'alice@example.com',
      verifiedAt: 1_756_000_000_000,
      discoverable: false,
      pendingEmail: null,
      pendingRequestedAt: null,
      restoredAt: null,
    });
    const tree = await render(<AccountEmailScreen onBack={jest.fn()} />);
    const toggle = tree.root
      .findAllByProps({ testID: 'discoverable-toggle' })
      .find(n => n.props.value !== undefined);
    expect(toggle).toBeDefined();
    expect(toggle!.props.value).toBe(false);
    tree.unmount();
  });

  it('a RESTORED identifier renders the placeholder honesty, and the controls exist', async () => {
    // A recovery restored the server-side consent, which this device cannot
    // read back: the row is marked `restoredAt`, the switch starts unset,
    // and the sentence beside it says exactly that — while the unlink and
    // downgrade controls exist (the recovered device is not control-less).
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue({
      email: 'alice@example.com',
      verifiedAt: 1_756_000_000_000,
      discoverable: false,
      pendingEmail: null,
      pendingRequestedAt: null,
      restoredAt: 1_756_000_000_000,
    });
    const tree = await render(<AccountEmailScreen onBack={jest.fn()} />);
    expect(
      tree.root.findAllByProps({ testID: 'discoverable-restored' }).length,
    ).toBeGreaterThan(0);
    expect(
      tree.root.findAllByProps({ testID: 'account-email-unlink' }).length,
    ).toBeGreaterThan(0);
    const rendered = JSON.stringify(tree.toJSON());
    expect(rendered).toContain('It cannot be read back here');
    tree.unmount();
  });
});

/* ── 1b. the code-request answer is honest about the maybe ─────────── */

describe('the code-request surface teaches the recipient budget (the uniform 200 stays uniform)', () => {
  // The email-code amendment: past the recipient budget (5/day
  // per address) or inside the 60 s resend cool-down the server DELIBERATELY
  // answers the same 200 and sends nothing — so the client's confirmation
  // says the maybe out loud, and the numbers teach statically behind the ⓘ
  // (house style), never in the refusal banner.
  async function requestFlow(): Promise<ReactTestRenderer.ReactTestRenderer> {
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(null);
    jest.spyOn(accounts, 'requestAttachCode').mockResolvedValue('sent');
    const tree = await render(<AccountEmailScreen onBack={jest.fn()} />);
    const input = tree.root
      .findAllByProps({ testID: 'account-email-input' })
      .find(n => n.props.onChangeText !== undefined)!;
    await ReactTestRenderer.act(async () => {
      input.props.onChangeText('alice@example.com');
    });
    const button = tree.root
      .findAllByProps({ testID: 'account-email-request' })
      .find(n => n.props.onPress !== undefined)!;
    await ReactTestRenderer.act(async () => {
      button.props.onPress();
    });
    return tree;
  }

  it('the post-request notice says the maybe — rationed, and asking again does not always send again', async () => {
    const tree = await requestFlow();
    const rendered = JSON.stringify(tree.toJSON());
    expect(rendered).toContain('a 6-digit code is on its way');
    expect(rendered).toContain(
      'This answer looks the same when nothing was sent — codes are rationed, so asking again does not always send again.',
    );
    tree.unmount();
  });

  it('the numbers live behind the ⓘ — 5 a day, one a minute, spent-allowance advice', async () => {
    const tree = await requestFlow();
    // Collapsed, the label is on the glass and the numbers are not.
    let rendered = JSON.stringify(tree.toJSON());
    expect(rendered).toContain(ACCOUNTS_COPY.emailCodeBudgetLabel);
    expect(rendered).not.toContain('at most 5 codes in a day');
    // Open it: the budget truth, in full — including what to do when the
    // allowance may be spent.
    const info = tree.root
      .findAllByProps({ testID: 'account-email-code-budget' })
      .find(n => n.props.onPress !== undefined)!;
    await ReactTestRenderer.act(async () => {
      info.props.onPress();
    });
    rendered = JSON.stringify(tree.toJSON());
    expect(rendered).toContain(
      'at most 5 codes in a day, and never more than one a minute',
    );
    // The day boundary is a UTC day, said as what it is — "tomorrow" by a
    // local clock can still be the same rationing day.
    expect(rendered).toContain(
      'resets at midnight UTC, which is probably not your midnight',
    );
    expect(rendered).toContain('may already be spent');
    expect(rendered).toContain('try again after midnight UTC, or use another address');
    tree.unmount();
  });

  it('the refusal banner stays collapsed — the budget wording never joins it (the server does not say which)', () => {
    // Byte-for-byte: teaching the budget in the refusal would claim a
    // reason the server deliberately withholds. The deck's refusal keeps
    // its landed sentence, and the budget words appear nowhere in it.
    expect(ACCOUNTS_COPY.emailRefused).toBe(
      'That did not work. The code may be wrong or expired, or this address may already be linked elsewhere — the server deliberately does not say which. Request a fresh code to try again.',
    );
    for (const word of ['rationed', 'allowance', 'budget']) {
      expect(ACCOUNTS_COPY.emailRefused).not.toContain(word);
    }
  });
});

/* ── 2. the find flow: typed email on the card, never a ULID ───────── */

describe('the find flow renders the typed email and never a ULID', () => {
  async function search(
    tree: ReactTestRenderer.ReactTestRenderer,
    typed: string,
  ): Promise<void> {
    const input = tree.root
      .findAllByProps({ testID: 'discovery-input' })
      .find(n => n.props.onChangeText !== undefined)!;
    await ReactTestRenderer.act(async () => {
      input.props.onChangeText(typed);
    });
    const button = tree.root
      .findAllByProps({ testID: 'discovery-search' })
      .find(n => n.props.onPress !== undefined)!;
    await ReactTestRenderer.act(async () => {
      button.props.onPress();
    });
  }

  it('the result card carries the TYPED address — verbatim, not normalized — and the resolved id never reaches glass', async () => {
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue({
      email: 'me@example.com',
      verifiedAt: 1,
      discoverable: false,
      pendingEmail: null,
      pendingRequestedAt: null,
      restoredAt: null,
    });
    jest
      .spyOn(accounts, 'discoverySearch')
      .mockResolvedValue({ outcome: 'found', anchor: ANCHOR, deviceCount: 2 });
    const tree = await render(
      <DiscoveryScreen onBack={jest.fn()} onOpenChat={jest.fn()} />,
    );
    await search(tree, 'Alice@Example.com');
    const rendered = JSON.stringify(tree.toJSON());
    // TYPED means typed: the label is the finder's
    // own text, capitalization included — normalization is the WIRE's
    // concern and never rewrites what the person wrote.
    expect(rendered).toContain('Start a chat with Alice@Example.com?');
    expect(rendered).toContain('This account answers on 2 devices.');
    // THE PHASE'S CENTRAL ASSERTION: no 26-char ULID anywhere in the tree.
    expect(ULID_RE.test(rendered)).toBe(false);
    tree.unmount();
  });

  it('tapping the card opens the chat at the resolved anchor — unrendered', async () => {
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(null);
    jest
      .spyOn(accounts, 'discoverySearch')
      .mockResolvedValue({ outcome: 'found', anchor: ANCHOR, deviceCount: 1 });
    const started = jest
      .spyOn(accounts, 'startDiscoveredChat')
      .mockResolvedValue(undefined);
    const onOpenChat = jest.fn();
    const tree = await render(
      <DiscoveryScreen onBack={jest.fn()} onOpenChat={onOpenChat} />,
    );
    await search(tree, 'alice@example.com');
    const card = tree.root
      .findAllByProps({ testID: 'discovery-result' })
      .find(n => n.props.onPress !== undefined)!;
    await ReactTestRenderer.act(async () => {
      card.props.onPress();
    });
    // The email leg's provenance mark is 'discovery', byte-unchanged since
    // Passed explicitly now that the username class marks its own chats 'discovery-username' through the same call.
    expect(started).toHaveBeenCalledWith('alice@example.com', ANCHOR, undefined, 'discovery');
    expect(onOpenChat).toHaveBeenCalledWith(ANCHOR);
    tree.unmount();
  });

  it('opening the chat performs NO key work — the ordinary thread owns bundle fetch + TOFU at first send', async () => {
    // The trust design, asserted instead of assumed: startDiscoveredChat
    // writes the chat row and the typed label and NOTHING ELSE — no bundle
    // fetch, no pin, no session. Discovery changes who you can reach,
    // never the trust model; the first message's ordinary send path is
    // where the bundle is fetched and the keys pin TOFU (messaging.ts —
    // encryptAndEnqueue's sessionless branch), byte-identical to a
    // QR-started chat. A pin made HERE would be a trust shortcut.
    const calls: string[] = [];
    const { deps } = fakeAccountsDeps();
    deps.api.getPrekeyBundle = async () => {
      calls.push('getPrekeyBundle');
      throw new Error('never called');
    };
    deps.db.upsertChat = async () => {
      calls.push('upsertChat');
    };
    deps.db.setLocalName = async (_id, name) => {
      calls.push(`setLocalName:${name}`);
    };
    await accounts.startDiscoveredChat('Alice@Example.com', ANCHOR, deps);
    expect(calls).toEqual(['upsertChat', 'setLocalName:Alice@Example.com']);
  });

  it('a superseded lookup can never render over a newer query', async () => {
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(null);
    // Two lookups in flight: the FIRST (stale) resolves found AFTER the
    // second (a miss) settles — its answer must be dropped, not rendered
    // over the newer query's outcome.
    let resolveFirst!: (v: accounts.DiscoveryOutcome) => void;
    const first = new Promise<accounts.DiscoveryOutcome>(resolve => {
      resolveFirst = resolve;
    });
    const searchSpy = jest
      .spyOn(accounts, 'discoverySearch')
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce({ outcome: 'no_match' });
    const tree = await render(
      <DiscoveryScreen onBack={jest.fn()} onOpenChat={jest.fn()} />,
    );
    await search(tree, 'alice@example.com');
    await search(tree, 'bob@example.com');
    await ReactTestRenderer.act(async () => {
      resolveFirst({ outcome: 'found', anchor: ANCHOR, deviceCount: 1 });
      await first;
    });
    expect(searchSpy).toHaveBeenCalledTimes(2);
    // The stale 'found' is dropped: the screen holds the newer miss.
    expect(tree.root.findAllByProps({ testID: 'discovery-result' })).toHaveLength(0);
    expect(
      tree.root.findAllByProps({ testID: 'discovery-no-match' }).length,
    ).toBeGreaterThan(0);
    tree.unmount();
  });

  it('miss, non-consented, cool-down, and spent budget are ONE indistinguishable outcome', async () => {
    // The module half, against the wire's REAL shape (finding
    // 15): the lookup route returns ONE frozen refusal for every refused
    // case — miss, non-consented, cool-down, AND the caller's own spent
    // budget — never a 429 (discovery.ts DISCOVERY_UNIFORM_REFUSAL). So the honest four-way drive is four IDENTICAL collapsed
    // 403s: the client cannot distinguish them because the bytes carry no
    // distinction to find, and this test documents that rather than
    // inventing per-case server shapes the handler forbids.
    const collapsedRefusalCases = [
      'miss',
      'non-consented',
      'cool-down',
      'spent budget',
    ].map(() => new ApiRequestError('refused', 403, 'accounts_refused'));
    const answers = [];
    for (const refusal of collapsedRefusalCases) {
      const { deps } = fakeAccountsDeps({
        lookup: async () => {
          throw refusal;
        },
      });
      answers.push(await accounts.discoverySearch('alice@example.com', deps));
    }
    expect(answers[0]).toEqual({ outcome: 'no_match' });
    for (const answer of answers) expect(answer).toEqual(answers[0]);
    // Defensive hardening, labeled as exactly that: an OFF-CONTRACT status
    // (the lookup never emits a 429 — the toggle's caller-keyed budget
    // does) still maps to the one refusal outcome rather than inventing a
    // distinction; a transport failure alone renders differently.
    const offContract = fakeAccountsDeps({
      lookup: async () => {
        throw new ApiRequestError('slow down', 429);
      },
    });
    expect(
      await accounts.discoverySearch('alice@example.com', offContract.deps),
    ).toEqual(answers[0]);

    // The screen half: the one outcome renders the one honest sentence.
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(null);
    jest
      .spyOn(accounts, 'discoverySearch')
      .mockResolvedValue({ outcome: 'no_match' });
    const tree = await render(
      <DiscoveryScreen onBack={jest.fn()} onOpenChat={jest.fn()} />,
    );
    await search(tree, 'alice@example.com');
    expect(
      tree.root.findAllByProps({ testID: 'discovery-no-match' }).length,
    ).toBeGreaterThan(0);
    expect(JSON.stringify(tree.toJSON())).toContain(
      'Tacendum cannot tell you which, by design.',
    );
    tree.unmount();
  });
});

/* ── 3. registration stays identifier-free ─────────────────────────── */

describe('registration screens contain zero identifier fields', () => {
  it('the register screen renders NO text input of any kind', async () => {
    const tree = await render(
      <RegisterScreen onBack={jest.fn()} onRegistered={jest.fn()} />,
    );
    // Stronger than "no email field": registration has no field at all —
    // identifier-free structurally, which is what keeps every
    // surviving "no sign-up" claim true.
    expect(tree.root.findAllByType(TextInput)).toHaveLength(0);
    const rendered = JSON.stringify(tree.toJSON());
    expect(rendered.includes('email-address')).toBe(false);
    expect(rendered.includes('phone-pad')).toBe(false);
    tree.unmount();
  });

  it('the recovery door lives BESIDE registration, on the landing surface', async () => {
    const tree = await render(
      <LandingScreen onGetStarted={jest.fn()} onRecover={jest.fn()} />,
    );
    expect(
      tree.root.findAllByProps({ testID: 'landing-recover' }).length,
    ).toBeGreaterThan(0);
    tree.unmount();
  });
});

/* ── 4. anchor choice under the class strip (build 19) ─────────────── */

describe('pickDiscoveryAnchor under the class strip', () => {
  // Deliberately unsorted ULIDs; the ascending order is B < C < D.
  const ULID_B = '01HQZZZZ00000000000000000B';
  const ULID_C = '01HQZZZZ00000000000000000C';
  const ULID_D = '01HQZZZZ00000000000000000D';

  it("members carrying one IDENTICAL constant class (tonight's server: 'phone' for everyone) anchor by ULID ascending", () => {
    const picked = accounts.pickDiscoveryAnchor({
      members: [
        { userId: ULID_D, class: 'phone' },
        { userId: ULID_B, class: 'phone' },
        { userId: ULID_C, class: 'phone' },
      ],
      rosterVersion: 4,
    });
    expect(picked).toEqual({ anchor: ULID_B, deviceCount: 3 });
  });

  it('members MISSING class entirely (the future field-dropping server) anchor by ULID ascending', () => {
    const picked = accounts.pickDiscoveryAnchor({
      members: [{ userId: ULID_C }, { userId: ULID_D }, { userId: ULID_B }],
      rosterVersion: 4,
    });
    expect(picked).toEqual({ anchor: ULID_B, deviceCount: 3 });
  });

  it('class is ignored UNCONDITIONALLY — a mixed/real-class response (which the planned wire never produces) still anchors by ULID ascending, never by any surviving class', () => {
    const picked = accounts.pickDiscoveryAnchor({
      members: [
        { userId: ULID_B }, // classless, ULID-smallest — WINS regardless
        { userId: ULID_D, class: 'desktop' }, // a surviving real class carries NO routing weight
      ],
      rosterVersion: 2,
    });
    expect(picked).toEqual({ anchor: ULID_B, deviceCount: 2 });
  });

  it('the email flow and the phone flow resolve the SAME anchor for the same answer — one shared helper', async () => {
    const response = {
      members: [{ userId: ULID_D, class: 'phone' as const }, { userId: ULID_B, class: 'phone' as const }],
      rosterVersion: 1,
    };
    const { deps } = fakeAccountsDeps({ lookup: async () => response });
    const emailAnswer = await accounts.discoverySearch('a@b.co', deps);
    expect(emailAnswer).toEqual({ outcome: 'found', anchor: ULID_B, deviceCount: 2 });
    // The phone twin does not duplicate the rule: accountsPhone.ts imports
    // pickDiscoveryAnchor from accounts.ts (asserted here by identity of
    // the resolved anchor over the identical wire answer).
    const phoneDeps: accountsPhone.AccountsPhoneDeps = {
      api: {
        phoneRequestCode: async () => undefined,
        phoneVerify: async () => undefined,
        phoneUnlink: async () => undefined,
        setPhoneDiscoverable: async () => undefined,
        discoveryLookupPhone: async () => response,
      },
      db: {
        loadPhoneIdentifier: async () => null,
        savePhoneIdentifier: async () => undefined,
        clearPhoneIdentifier: async () => undefined,
      },
      token: async () => 'bearer',
      now: () => 1_756_000_000_000,
    };
    const phoneAnswer = await accountsPhone.discoverySearchByPhone('+15555550100', phoneDeps);
    expect(phoneAnswer).toEqual({ outcome: 'found', anchor: ULID_B, deviceCount: 2 });
  });
});
