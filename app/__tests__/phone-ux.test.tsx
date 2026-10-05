/**
 * THE PHONE SURFACES, DARK BEHIND THE BUILD PIN — the
 * phase Verify's six properties, each against the real screens, the real
 * state machines, and (for the finding-11 halves) the REAL SQLite engine:
 *
 *  1. DISCOVERABILITY DEFAULTS OFF for a freshly verified phone — the
 *     toggle's INITIAL state asserted (the Switch's `value`), not the copy,
 *     and confirmPhoneAttach records `discoverable: false` with no code
 *     path to ON without the owner's own later toggle.
 *
 *  2. THE FIND FLOW renders the TYPED number VERBATIM on the result card
 *     and NEVER a 26-char ULID (regex over the entire rendered tree); the
 *     class is SHOWN and chosen, never inferred; and every server refusal
 *     of the phone class is the ONE outcome (the four-way copy extends).
 *
 *  3. PER-CLASS CONSENT is structural (the finding-11 migration): the
 *     phone toggle renders the per-class sentence, and driving EITHER class's
 *     toggle through the real state machine against the real schema leaves
 *     the OTHER class's row raw-equal — both directions.
 *
 *  4. PHONE RECOVERY END-TO-END LOCALLY: started → relaunch
 *     (the durable kind='phone' recovery_local row re-enters) → completion
 *     writes the kind='phone' identifier row as the restoredAt
 *     placeholder, NEVER an email row.
 *
 *  5. THE MIGRATION drives an earlier-era database file forward with the
 *     landed email row surviving raw-equal under kind='email' (and a
 *     started recovery defaulting to kind='email').
 *
 *  6. WITH PHONE_UI_ENABLED OFF the phone surfaces render
 *     NOTHING and the landed world is unchanged — and RegisterScreen still
 *     renders ZERO identifier fields (structural).
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { Linking, TextInput } from 'react-native';
import {
  DiscoveryLookupRequest,
  PhoneCodeRequest,
  PhoneVerifyRequest,
  RecoveryCodeRequest,
  RecoveryVerifyRequest,
} from '@tacendum/shared';
import {
  ApiRequestError,
  apiDiscoveryLookup,
  apiDiscoveryLookupPhone,
  apiRecoveryRequestCode,
  apiRecoveryRequestCodePhone,
  apiRecoveryVerifyPhone,
  apiRequestPhoneCode,
  apiVerifyPhone,
} from '../src/api';
import * as accounts from '../src/accounts';
import * as accountsPhone from '../src/accountsPhone';
import { ACCOUNTS_PHONE_COPY } from '../src/accountsPhoneCopy';
import * as db from '../src/db';
import { AccountPhoneScreen } from '../src/screens/AccountPhoneScreen';
import { DiscoveryScreen } from '../src/screens/DiscoveryScreen';
import { RecoveryScreen } from '../src/screens/RecoveryScreen';
import { RegisterScreen } from '../src/screens/RegisterScreen';
import { USERNAME_UI_ENABLED } from '../src/usernameUi';

jest.mock('../src/registration', () => ({
  createOrRestoreAccount: jest.fn(),
}));

/** The build pin, flipped per test: a getter so every render reads the
 * CURRENT value — exactly what the shipped constant would be at build time.
 * Default ON in this suite (the dark half sets it false explicitly): the
 * enabled state is what a phone-enabled build ships, and the OFF state is what every
 * release binary holds until then. */
let mockPhoneUiEnabled = true;
jest.mock('../src/phoneUi', () => ({
  get PHONE_UI_ENABLED() {
    return mockPhoneUiEnabled;
  },
}));

/** The Crockford ULID shape — what must never appear in the rendered tree. */
const ULID_RE = /[0-9A-HJKMNP-TV-Z]{26}/;

const ANCHOR = '01HQZZZZ00000000000000000A';
const SELF = '01HQSELF000000000000000000';
const GROUP = '01HQGGGG0000000000000000G0';
const NOW_MS = 1_756_000_000_000;
const REFUSAL = () => new ApiRequestError('refused', 403, 'accounts_refused');

/* ── the call-ledger fakes (the accounts-flows discipline) ─────────── */

function fakePhoneDeps(
  overrides: Partial<accountsPhone.AccountsPhoneDeps['api']> = {},
): {
  deps: accountsPhone.AccountsPhoneDeps;
  saved: db.PhoneIdentifierRow[];
  apiCalls: string[];
} {
  const saved: db.PhoneIdentifierRow[] = [];
  const apiCalls: string[] = [];
  const deps: accountsPhone.AccountsPhoneDeps = {
    api: {
      phoneRequestCode: async () => {
        apiCalls.push('phoneRequestCode');
      },
      phoneVerify: async () => {
        apiCalls.push('phoneVerify');
      },
      phoneUnlink: async () => {
        apiCalls.push('phoneUnlink');
      },
      setPhoneDiscoverable: async () => {
        apiCalls.push('setPhoneDiscoverable');
      },
      discoveryLookupPhone: async () => {
        apiCalls.push('discoveryLookupPhone');
        return {
          members: [{ userId: ANCHOR, class: 'phone' as const }],
          rosterVersion: 1,
        };
      },
      ...overrides,
    },
    db: {
      loadPhoneIdentifier: async () => saved[saved.length - 1] ?? null,
      savePhoneIdentifier: async row => {
        saved.push({ ...row });
      },
      clearPhoneIdentifier: async () => undefined,
    },
    token: async () => 'bearer',
    now: () => NOW_MS,
  };
  return { deps, saved, apiCalls };
}

async function render(
  el: React.ReactElement,
): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(el);
  });
  return tree;
}

async function press(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): Promise<void> {
  const node = tree.root
    .findAllByProps({ testID })
    .find(n => n.props.onPress !== undefined)!;
  await ReactTestRenderer.act(async () => {
    node.props.onPress();
  });
}

afterEach(() => {
  mockPhoneUiEnabled = true;
  jest.restoreAllMocks();
});

/* ── the REAL engine, bound under the recorded op-sqlite mock (the
 *    db.consent.test.ts harness) — the finding-11 halves need real SQL ── */

type Row = Record<string, unknown>;
interface Engine {
  prepare(sql: string): { all(...args: unknown[]): Row[] };
  exec(sql: string): void;
  close(): void;
}
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (p: string) => Engine;
};
interface FakeDb {
  name: string;
  execute: jest.Mock;
  close: jest.Mock;
}
const sqlite = jest.requireMock('@op-engineering/op-sqlite') as {
  open: (o: { name: string }) => FakeDb;
  __sqlite: { instances: Map<string, FakeDb>; reset: () => void };
};

function bindRealEngine(engine: Engine): void {
  const instance = sqlite.open({ name: 'tacendum.sqlite' });
  instance.execute.mockImplementation(async (sql: unknown, params?: unknown[]) => {
    const args = (params ?? []).map(p => (p === undefined ? null : p));
    const rows = engine.prepare(String(sql)).all(...args);
    const changes = engine.prepare('SELECT changes() AS c').all()[0]!.c as number;
    return { rows, rowsAffected: changes };
  });
}

/** AccountsDeps against the REAL db module (bound to the real engine) with
 * a permissive api fake — what the recovery drive and the consent-isolation
 * drive both ride. */
function realDbAccountsDeps(
  completesAt: number,
): { deps: accounts.AccountsDeps; apiCalls: string[] } {
  const apiCalls: string[] = [];
  const ok = (name: string) => async () => {
    apiCalls.push(name);
  };
  const deps: accounts.AccountsDeps = {
    api: {
      emailRequestCode: ok('emailRequestCode'),
      emailVerify: ok('emailVerify'),
      emailUnlink: ok('emailUnlink'),
      setDiscoverable: ok('setDiscoverable'),
      discoveryLookup: async () => {
        throw REFUSAL();
      },
      recoveryRequestCode: ok('recoveryRequestCode'),
      recoveryVerify: async () => ({ groupId: GROUP, completesAt }),
      recoveryRequestCodePhone: ok('recoveryRequestCodePhone'),
      recoveryVerifyPhone: async () => {
        apiCalls.push('recoveryVerifyPhone');
        return { groupId: GROUP, completesAt };
      },
      recoveryCancel: ok('recoveryCancel'),
      recoveryComplete: ok('recoveryComplete'),
      authChallenge: async () => ({ challenge: 'CHAL' }),
      getPrekeyBundle: async () => ({ userId: SELF, rosterVersion: 1 }) as never,
    },
    crypto: {
      identityPublicKey: async () => 'IDKEY',
      signAuthChallenge: async c => `sig(${c})`,
    },
    db,
    dissolve: async () => undefined,
    token: async () => 'bearer',
    selfId: async () => SELF,
    now: () => NOW_MS,
  };
  return { deps, apiCalls };
}

/* ── 1. default OFF for a freshly verified phone ───────────────────── */

describe('discoverability defaults OFF for a freshly verified phone', () => {
  it('confirmPhoneAttach records discoverable: false at the verify moment', async () => {
    const { deps, saved } = fakePhoneDeps();
    const outcome = await accountsPhone.confirmPhoneAttach(
      '+1 (555) 555-0100',
      '123456',
      deps,
    );
    expect(outcome).toBe('attached');
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      phone: '+15555550100', // normalized — the wire spelling
      discoverable: false,
      restoredAt: null,
    });
  });

  it('a REFUSED verify records nothing — refusal-first', async () => {
    const { deps, saved } = fakePhoneDeps({
      phoneVerify: async () => {
        throw REFUSAL();
      },
    });
    expect(await accountsPhone.confirmPhoneAttach('+15555550100', '000000', deps)).toBe(
      'refused',
    );
    expect(saved).toHaveLength(0);
  });

  it('a malformed number is refused LOCALLY — nothing reaches the wire (refused, never repaired)', async () => {
    const { deps, saved, apiCalls } = fakePhoneDeps();
    // No +: the client must not guess a country.
    expect(await accountsPhone.requestPhoneAttachCode('555 555 0100', deps)).toBe(
      'invalid',
    );
    // Letters, extensions, over-long: all the same local refusal.
    expect(await accountsPhone.requestPhoneAttachCode('+1555CALLME', deps)).toBe('invalid');
    expect(await accountsPhone.confirmPhoneAttach('05555550100', '123456', deps)).toBe(
      'invalid',
    );
    expect(apiCalls).toEqual([]);
    expect(saved).toHaveLength(0);
  });

  it("the toggle's INITIAL state is off on the phone surface", async () => {
    jest.spyOn(db, 'loadPhoneIdentifier').mockResolvedValue({
      phone: '+15555550100',
      verifiedAt: NOW_MS,
      discoverable: false,
      pendingPhone: null,
      pendingRequestedAt: null,
      restoredAt: null,
    });
    const tree = await render(<AccountPhoneScreen onBack={jest.fn()} />);
    const toggle = tree.root
      .findAllByProps({ testID: 'number-discoverable-toggle' })
      .find(n => n.props.value !== undefined);
    expect(toggle).toBeDefined();
    expect(toggle!.props.value).toBe(false);
    tree.unmount();
  });
});

/* ── 1b. the code-request answer is honest about the maybe ─────────── */

describe('the phone code-request surface teaches the recipient budget (the email amendment, per class)', () => {
  // The email-code amendment's phone twin: past 3/day per number
  // or inside the 60 s resend cool-down the server answers the same 200 and
  // sends nothing — the confirmation says the maybe, the ⓘ carries the
  // phone class's own numbers, and the refusal banner stays collapsed.
  async function requestFlow(): Promise<ReactTestRenderer.ReactTestRenderer> {
    jest.spyOn(db, 'loadPhoneIdentifier').mockResolvedValue(null);
    jest.spyOn(accountsPhone, 'requestPhoneAttachCode').mockResolvedValue('sent');
    const tree = await render(<AccountPhoneScreen onBack={jest.fn()} />);
    const input = tree.root
      .findAllByProps({ testID: 'account-number-input' })
      .find(n => n.props.onChangeText !== undefined)!;
    await ReactTestRenderer.act(async () => {
      input.props.onChangeText('+15555550100');
    });
    // The DIGITAL_FORM opt-in: the send affordance is dark until the
    // separate SMS consent box is checked — the flow every ATTACH request
    // takes. (The recovery leg sends without this box: whether the
    // attach-time opt-in covers texts to the already-linked number is the
    // ruled behavior, recorded where it lands.)
    await press(tree, 'account-number-sms-consent');
    await press(tree, 'account-number-request');
    return tree;
  }

  it('the post-request notice says the maybe, and the ⓘ carries 3 a day, one a minute', async () => {
    const tree = await requestFlow();
    let rendered = JSON.stringify(tree.toJSON());
    expect(rendered).toContain('a 6-digit code is on its way');
    expect(rendered).toContain(
      'This answer looks the same when nothing was sent — codes are rationed, so asking again does not always send again.',
    );
    // Collapsed, the label is on the glass and the numbers are not.
    expect(rendered).toContain(ACCOUNTS_PHONE_COPY.numberCodeBudgetLabel);
    expect(rendered).not.toContain('at most 3 codes in a day');
    await press(tree, 'account-number-code-budget');
    rendered = JSON.stringify(tree.toJSON());
    expect(rendered).toContain(
      'at most 3 codes in a day, and never more than one a minute',
    );
    // The day boundary is a UTC day, said as what it is — "tomorrow" by a
    // local clock can still be the same rationing day.
    expect(rendered).toContain(
      'resets at midnight UTC, which is probably not your midnight',
    );
    expect(rendered).toContain('may already be spent');
    expect(rendered).toContain(
      'Try again after midnight UTC, or use another number that can receive texts.',
    );
    tree.unmount();
  });

  it('the refusal banner stays collapsed — the budget wording never joins it', () => {
    expect(ACCOUNTS_PHONE_COPY.numberRefused).toBe(
      'That did not work. The code may be wrong or expired, or this number may already be linked elsewhere — the server deliberately does not say which. Request a fresh code to try again.',
    );
    for (const word of ['rationed', 'allowance', 'budget']) {
      expect(ACCOUNTS_PHONE_COPY.numberRefused).not.toContain(word);
    }
  });
});

/* ── 1c. the SMS consent checkbox (the US toll-free DIGITAL_FORM
 *    opt-in): separate, UNCHECKED, and it alone arms the send ───────── */

describe('the SMS consent checkbox is separate, unchecked by default, and gates the send', () => {
  async function attachForm(): Promise<ReactTestRenderer.ReactTestRenderer> {
    jest.spyOn(db, 'loadPhoneIdentifier').mockResolvedValue(null);
    const tree = await render(<AccountPhoneScreen onBack={jest.fn()} />);
    const input = tree.root
      .findAllByProps({ testID: 'account-number-input' })
      .find(n => n.props.onChangeText !== undefined)!;
    await ReactTestRenderer.act(async () => {
      input.props.onChangeText('+15555550100');
    });
    return tree;
  }

  const consentBox = (tree: ReactTestRenderer.ReactTestRenderer) =>
    tree.root
      .findAllByProps({ testID: 'account-number-sms-consent' })
      .find(n => n.props.accessibilityRole === 'checkbox')!;

  const sendDisabled = (tree: ReactTestRenderer.ReactTestRenderer): boolean =>
    tree.root
      .findAllByProps({ testID: 'account-number-request' })
      .find(n => n.props.accessibilityState !== undefined)!.props
      .accessibilityState.disabled as boolean;

  it('UNCHECKED by default — its own labeled checkbox row, never bundled into another consent', async () => {
    const tree = await attachForm();
    const box = consentBox(tree);
    // The a11y contract: a real checkbox role, unchecked, carrying the ONE
    // deck sentence as its own label — reachable and labeled.
    expect(box.props.accessibilityState.checked).toBe(false);
    expect(box.props.accessibilityLabel).toBe(ACCOUNTS_PHONE_COPY.smsConsentLabel);
    // Its own row: the discoverability Switch is a DIFFERENT control and is
    // not on the attach form at all — no other consent shares this row.
    expect(
      tree.root.findAllByProps({ testID: 'number-discoverable-toggle' }),
    ).toHaveLength(0);
    tree.unmount();
  });

  it('the send affordance stays disabled until checked; unchecking re-disables', async () => {
    const tree = await attachForm();
    // A typed number ALONE is grounds for nothing: still disabled.
    expect(sendDisabled(tree)).toBe(true);
    await press(tree, 'account-number-sms-consent');
    expect(consentBox(tree).props.accessibilityState.checked).toBe(true);
    expect(sendDisabled(tree)).toBe(false);
    // Unchecking re-disables — consent is live state, not a latch.
    await press(tree, 'account-number-sms-consent');
    expect(consentBox(tree).props.accessibilityState.checked).toBe(false);
    expect(sendDisabled(tree)).toBe(true);
    tree.unmount();
  });

  it('Terms and Privacy links sit BESIDE the checkbox — independently tappable, opening the pinned policy URLs', async () => {
    const opened: string[] = [];
    jest.spyOn(Linking, 'openURL').mockImplementation(async url => {
      opened.push(url);
    });
    const tree = await attachForm();
    // Adjacent and their own press targets: tapping a policy link opens the
    // compile-time policy URL (the review criteria's T&C/privacy links at
    // the opt-in point)...
    await press(tree, 'account-number-sms-terms');
    await press(tree, 'account-number-sms-privacy');
    expect(opened).toEqual(['https://tacendum.com/terms/', 'https://tacendum.com/privacy/']);
    // ...and NEVER toggles consent — the links live outside the checkbox's
    // press target, so reading a policy is not an opt-in.
    expect(consentBox(tree).props.accessibilityState.checked).toBe(false);
    expect(sendDisabled(tree)).toBe(true);
    tree.unmount();
  });

  it('the consent sentence is ONE deck string, byte-for-byte — the carrier registration quotes it', () => {
    expect(ACCOUNTS_PHONE_COPY.smsConsentLabel).toBe(
      'By checking, you consent to receive one-time verification codes from Mirana Technologies Inc. Message frequency: one code per request. Message and data rates may apply. Reply HELP for help or STOP to opt out.',
    );
  });

  it('the byte-pinned refusal and confirmation lines are untouched beside it', () => {
    // The uniform-answer confirmation, verbatim — the consent sentence never
    // joined it.
    expect(ACCOUNTS_PHONE_COPY.numberCodeSent('+15555550100')).toBe(
      'If +15555550100 can receive text messages from Tacendum, a 6-digit code is on its way. It works for 5 minutes. This answer looks the same when nothing was sent — codes are rationed, so asking again does not always send again.',
    );
    // The collapsed refusal, verbatim.
    expect(ACCOUNTS_PHONE_COPY.numberRefused).toBe(
      'That did not work. The code may be wrong or expired, or this number may already be linked elsewhere — the server deliberately does not say which. Request a fresh code to try again.',
    );
    // Separation both ways: consent wording stays out of them.
    for (const line of [
      ACCOUNTS_PHONE_COPY.numberCodeSent('+15555550100'),
      ACCOUNTS_PHONE_COPY.numberRefused,
    ]) {
      expect(line).not.toContain('you consent');
      expect(line).not.toContain('STOP');
    }
  });
});

/* ── 2. find-by-phone: the typed number on the card, never a ULID ──── */

describe('the find flow renders the TYPED number and never a ULID', () => {
  async function type(
    tree: ReactTestRenderer.ReactTestRenderer,
    text: string,
  ): Promise<void> {
    const input = tree.root
      .findAllByProps({ testID: 'discovery-input' })
      .find(n => n.props.onChangeText !== undefined)!;
    await ReactTestRenderer.act(async () => {
      input.props.onChangeText(text);
    });
  }

  it('the result card carries the number VERBATIM — formatting included — and the resolved id never reaches glass', async () => {
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(null);
    jest.spyOn(db, 'loadPhoneIdentifier').mockResolvedValue({
      phone: '+15555550199',
      verifiedAt: 1,
      discoverable: false,
      pendingPhone: null,
      pendingRequestedAt: null,
      restoredAt: null,
    });
    jest
      .spyOn(accountsPhone, 'discoverySearchByPhone')
      .mockResolvedValue({ outcome: 'found', anchor: ANCHOR, deviceCount: 2 });
    const tree = await render(
      <DiscoveryScreen onBack={jest.fn()} onOpenChat={jest.fn()} />,
    );
    await press(tree, 'discovery-class-number');
    await type(tree, '+1 (555) 555-0100');
    await press(tree, 'discovery-search');
    const rendered = JSON.stringify(tree.toJSON());
    // TYPED means typed (the landed rule, extended): the finder's own
    // formatting survives — normalization is the WIRE's concern.
    expect(rendered).toContain('Open a room with +1 (555) 555-0100?');
    expect(rendered).toContain('This account answers on 2 devices.');
    // THE PHASE'S CENTRAL ASSERTION: no 26-char ULID anywhere in the tree.
    expect(ULID_RE.test(rendered)).toBe(false);
    tree.unmount();
  });

  it('the class is SHOWN and chosen — the number class dispatches the phone lookup, never inferred from the text', async () => {
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(null);
    jest.spyOn(db, 'loadPhoneIdentifier').mockResolvedValue(null);
    const emailSearch = jest
      .spyOn(accounts, 'discoverySearch')
      .mockResolvedValue({ outcome: 'no_match' });
    const phoneSearch = jest
      .spyOn(accountsPhone, 'discoverySearchByPhone')
      .mockResolvedValue({ outcome: 'no_match' });
    const tree = await render(
      <DiscoveryScreen onBack={jest.fn()} onOpenChat={jest.fn()} />,
    );
    // Both class entries exist — the choice is visible, not guessed.
    expect(
      tree.root.findAllByProps({ testID: 'discovery-class-email' }).length,
    ).toBeGreaterThan(0);
    await press(tree, 'discovery-class-number');
    // An email-SHAPED text under the number class still searches by the
    // CHOSEN class: the phone leg refuses it locally as not-a-number, and
    // the email lookup is never consulted — no silent inference.
    await type(tree, 'alice@example.com');
    await press(tree, 'discovery-search');
    expect(phoneSearch).toHaveBeenCalledWith('alice@example.com');
    expect(emailSearch).not.toHaveBeenCalled();
    tree.unmount();
  });

  it('miss, non-consented, cool-down, and spent budget are ONE indistinguishable outcome for the phone class', async () => {
    // The module half, HONESTLY SCOPED: this drives
    // the CLIENT's collapse mapping over a mocked refusal — the four named
    // cases exist server-side, where the server suites prove the route
    // answers all of them with the one frozen 403; here the labels only
    // document what the identical mocked answers stand for. The REAL wire
    // bytes the client emits are pinned by the serializer block below
    // ("the phone payloads survive the REAL serializer"), not by this
    // test.
    const answers = [];
    for (const label of ['miss', 'non-consented', 'cool-down', 'spent budget']) {
      void label;
      const { deps } = fakePhoneDeps({
        discoveryLookupPhone: async () => {
          throw REFUSAL();
        },
      });
      answers.push(await accountsPhone.discoverySearchByPhone('+15555550100', deps));
    }
    expect(answers[0]).toEqual({ outcome: 'no_match' });
    for (const answer of answers) expect(answer).toEqual(answers[0]);

    // The screen half: the phone-classed miss renders the one honest
    // sentence — the designed indistinguishability named for the number.
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(null);
    jest.spyOn(db, 'loadPhoneIdentifier').mockResolvedValue(null);
    jest
      .spyOn(accountsPhone, 'discoverySearchByPhone')
      .mockResolvedValue({ outcome: 'no_match' });
    const tree = await render(
      <DiscoveryScreen onBack={jest.fn()} onOpenChat={jest.fn()} />,
    );
    await press(tree, 'discovery-class-number');
    await type(tree, '+15555550100');
    await press(tree, 'discovery-search');
    const rendered = JSON.stringify(tree.toJSON());
    expect(rendered).toContain('this number may not be on Tacendum');
    expect(rendered).toContain('Tacendum cannot tell you which, by design.');
    tree.unmount();
  });
});

/* ── 3 + 4 + 5. the REAL schema: consent isolation, phone recovery,
 *    and the earlier-era migration ─────────────────────────────────── */

describe('the finding-11 halves, on the real engine', () => {
  let engine: Engine;

  afterEach(async () => {
    await db.close();
    engine.close();
  });

  async function freshDb(): Promise<void> {
    await db.close();
    sqlite.__sqlite.reset();
    engine = new DatabaseSync(':memory:');
    bindRealEngine(engine);
    db.setWorkspace('real');
    await db.initDb();
  }

  const dumpIdentifiers = (): Row[] =>
    engine
      .prepare('SELECT kind, value, verifiedAt, discoverable, pendingValue, pendingRequestedAt, restoredAt FROM account_identifier ORDER BY kind')
      .all();

  it('per-class consent is STRUCTURAL: either toggle moves its own row alone, both directions', async () => {
    await freshDb();
    await db.saveAccountIdentifier({
      email: 'alice@example.com',
      verifiedAt: 111,
      discoverable: false,
      pendingEmail: null,
      pendingRequestedAt: null,
      restoredAt: null,
    });
    await db.savePhoneIdentifier({
      phone: '+15555550100',
      verifiedAt: 222,
      discoverable: false,
      pendingPhone: null,
      pendingRequestedAt: null,
      restoredAt: null,
    });

    // Phone ON through the REAL state machine: the phone row moves, the
    // email row is raw-equal to its pre-toggle dump.
    const before = dumpIdentifiers();
    const phoneDeps: accountsPhone.AccountsPhoneDeps = {
      api: {
        phoneRequestCode: async () => undefined,
        phoneVerify: async () => undefined,
        phoneUnlink: async () => undefined,
        setPhoneDiscoverable: async () => undefined,
        discoveryLookupPhone: async () => {
          throw REFUSAL();
        },
      },
      db,
      token: async () => 'bearer',
      now: () => NOW_MS,
    };
    expect(await accountsPhone.setPhoneDiscoverable(true, phoneDeps)).toBe('ok');
    let after = dumpIdentifiers();
    expect(after.find(r => r.kind === 'phone')!.discoverable).toBe(1);
    expect(after.find(r => r.kind === 'email')).toEqual(
      before.find(r => r.kind === 'email'),
    );

    // And the mirror: email ON moves the email row alone — the phone
    // row's just-written consent survives raw-equal.
    const mid = dumpIdentifiers();
    const { deps } = realDbAccountsDeps(0);
    expect(await accounts.setDiscoverable(true, deps)).toBe('ok');
    after = dumpIdentifiers();
    expect(after.find(r => r.kind === 'email')!.discoverable).toBe(1);
    expect(after.find(r => r.kind === 'phone')).toEqual(
      mid.find(r => r.kind === 'phone'),
    );
  });

  it('the per-class sentence renders ON the phone toggle (and the phone unlink names the surviving email)', async () => {
    await freshDb();
    await db.savePhoneIdentifier({
      phone: '+15555550100',
      verifiedAt: 222,
      discoverable: false,
      pendingPhone: null,
      pendingRequestedAt: null,
      restoredAt: null,
    });
    const tree = await render(<AccountPhoneScreen onBack={jest.fn()} />);
    await press(tree, 'number-discoverable-info');
    let rendered = JSON.stringify(tree.toJSON());
    // The per-class fact in plain words, on the toggle's own teaching copy…
    expect(rendered).toContain(
      'does not make your email findable, and the other way round',
    );
    // …and the honest weakness at full sharpness beside it: the
    // RULED phrase, never the softened one, with the mechanism named.
    expect(rendered).toContain('never server-blindness');
    expect(rendered).toContain(
      'only through that secret plus the strict limits on who may search and how often',
    );
    // The unlink confirm's keep verb comes FROM THE DECK on the glass (fix
    // pass): a hardcoded screen literal escaped the drift net.
    await press(tree, 'account-number-unlink');
    rendered = JSON.stringify(tree.toJSON());
    expect(rendered).toContain(ACCOUNTS_PHONE_COPY.numberUnlinkKeep);
    expect(
      tree.root.findAllByProps({ testID: 'account-number-unlink-cancel' }).length,
    ).toBeGreaterThan(0);
    tree.unmount();
  });

  it('PHONE RECOVERY end-to-end locally: started → relaunch re-enters → completion writes the kind=phone row, never an email row', async () => {
    await freshDb();
    const completesAt = Math.floor(NOW_MS / 1000) - 1; // ready immediately
    const { deps } = realDbAccountsDeps(completesAt);

    // STARTED: the verify leg births the durable TYPED pending row.
    const started = await accounts.confirmRecoveryCodeByPhone(
      '+1 555 555 0100',
      '123456',
      deps,
    );
    expect(started.outcome).toBe('pending');
    const pendingRows = engine
      .prepare('SELECT kind, value, groupId FROM recovery_local')
      .all();
    expect(pendingRows).toEqual([
      { kind: 'phone', value: '+15555550100', groupId: GROUP },
    ]);

    // RELAUNCH: close and re-open the SAME file — the durable row is what
    // carries a started recovery across relaunches (App.tsx's boot
    // re-entry reads exactly this load).
    await db.close();
    await db.initDb();
    const reentered = await db.loadLocalRecovery();
    expect(reentered).toMatchObject({ kind: 'phone', value: '+15555550100' });

    // COMPLETION: the local half restores the PHONE identifier as the
    // restoredAt placeholder — typed off the pending row's own kind.
    expect(await accounts.completeRecovery(deps)).toBe('completed');
    const rows = dumpIdentifiers();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'phone',
      value: '+15555550100',
      discoverable: 0,
    });
    expect(rows[0]!.restoredAt).not.toBeNull();
    // NEVER an email row — the earlier write-back-as-email is the exact
    // dishonesty this suite exists to forbid.
    expect(rows.find(r => r.kind === 'email')).toBeUndefined();
    // …and the pending row is consumed.
    expect(engine.prepare('SELECT * FROM recovery_local').all()).toEqual([]);
  });

  it('the MIGRATION carries an earlier-era file forward: the landed email row survives raw-equal under kind=email', async () => {
    // An earlier-era file, seeded with the OLD shapes and the landed rows
    // BEFORE the app's schema ever runs.
    await db.close();
    sqlite.__sqlite.reset();
    engine = new DatabaseSync(':memory:');
    engine.exec(`
      CREATE TABLE account_identifier (
        key TEXT PRIMARY KEY CHECK (key = 'identifier'),
        email TEXT,
        verifiedAt INTEGER,
        discoverable INTEGER NOT NULL DEFAULT 0,
        pendingEmail TEXT,
        pendingRequestedAt INTEGER,
        restoredAt INTEGER
      );
      INSERT INTO account_identifier
        (key, email, verifiedAt, discoverable, pendingEmail, pendingRequestedAt, restoredAt)
      VALUES ('identifier', 'alice@example.com', 111, 1, NULL, NULL, NULL);
      CREATE TABLE recovery_local (
        key TEXT PRIMARY KEY CHECK (key = 'recovery'),
        email TEXT NOT NULL,
        groupId TEXT NOT NULL,
        completesAt INTEGER NOT NULL,
        verifiedAt INTEGER NOT NULL
      );
      INSERT INTO recovery_local (key, email, groupId, completesAt, verifiedAt)
      VALUES ('recovery', 'alice@example.com', '${GROUP}', 999, 111);
    `);
    bindRealEngine(engine);
    db.setWorkspace('real');
    await db.initDb();

    // The landed email row, raw-equal under kind='email' — every column
    // carried, nothing invented.
    expect(dumpIdentifiers()).toEqual([
      {
        kind: 'email',
        value: 'alice@example.com',
        verifiedAt: 111,
        discoverable: 1,
        pendingValue: null,
        pendingRequestedAt: null,
        restoredAt: null,
      },
    ]);
    // The landed READERS see the world unchanged.
    expect(await db.loadAccountIdentifier()).toEqual({
      email: 'alice@example.com',
      verifiedAt: 111,
      discoverable: true,
      pendingEmail: null,
      pendingRequestedAt: null,
      restoredAt: null,
    });
    // A pre-migration STARTED recovery defaults to 'email' — the only kind
    // that could have started one — with its columns carried.
    expect(engine.prepare('SELECT kind, value, groupId, completesAt, verifiedAt FROM recovery_local').all()).toEqual([
      { kind: 'email', value: 'alice@example.com', groupId: GROUP, completesAt: 999, verifiedAt: 111 },
    ]);
    // And the migration is idempotent: a second boot rebuilds nothing.
    await db.close();
    await db.initDb();
    expect(dumpIdentifiers()).toHaveLength(1);
  });
});

/* ── 6. PHONE_UI_ENABLED OFF: the surfaces render NOTHING ──────────── */

describe('with PHONE_UI_ENABLED off, the phone surfaces render NOTHING', () => {
  it('AccountPhoneScreen renders null — even entered programmatically', async () => {
    mockPhoneUiEnabled = false;
    jest.spyOn(db, 'loadPhoneIdentifier').mockResolvedValue(null);
    const tree = await render(<AccountPhoneScreen onBack={jest.fn()} />);
    expect(tree.toJSON()).toBeNull();
    tree.unmount();
  });

  it('the find flow shows no phone class entry and no phone wording — the landed world, unchanged by THIS pin', async () => {
    mockPhoneUiEnabled = false;
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(null);
    const tree = await render(
      <DiscoveryScreen onBack={jest.fn()} onOpenChat={jest.fn()} />,
    );
    expect(tree.root.findAllByProps({ testID: 'discovery-class-number' })).toHaveLength(0);
    // The class selector (and its email chip) is live when ANY typed class
    // beyond email is — since build 23 that is the username pin (real
    // module, not mocked here), never this one. With the username pin OFF
    // this line is the landed world's zero again.
    expect(tree.root.findAllByProps({ testID: 'discovery-class-email' }).length > 0).toBe(USERNAME_UI_ENABLED);
    const rendered = JSON.stringify(tree.toJSON());
    expect(rendered.includes('Phone number')).toBe(false);
    expect(rendered.includes('phone-pad')).toBe(false);
    tree.unmount();
  });

  it('the recovery door shows no phone entry and keeps the landed scope sentence byte-for-byte', async () => {
    mockPhoneUiEnabled = false;
    jest.spyOn(db, 'loadLocalRecovery').mockResolvedValue(null);
    const profile = { userId: SELF, registrationId: 7 } as unknown as db.ProfileRow;
    const tree = await render(
      <RecoveryScreen
        profile={profile}
        onBack={jest.fn()}
        onCreateIdentity={jest.fn()}
        onDone={jest.fn()}
      />,
    );
    expect(tree.root.findAllByProps({ testID: 'recovery-class-number' })).toHaveLength(0);
    const rendered = JSON.stringify(tree.toJSON());
    // The LANDED sentence, email-only clause included — the phone-aware
    // variant must not leak into a dark binary's scope copy.
    expect(rendered).toContain('which devices are yours, and your findability by email.');
    expect(rendered.includes('email or phone number')).toBe(false);
    tree.unmount();
  });

  it('…and ON, the door offers the phone entry with the same scope honesty', async () => {
    jest.spyOn(db, 'loadLocalRecovery').mockResolvedValue(null);
    const profile = { userId: SELF, registrationId: 7 } as unknown as db.ProfileRow;
    const tree = await render(
      <RecoveryScreen
        profile={profile}
        onBack={jest.fn()}
        onCreateIdentity={jest.fn()}
        onDone={jest.fn()}
      />,
    );
    expect(
      tree.root.findAllByProps({ testID: 'recovery-class-number' }).length,
    ).toBeGreaterThan(0);
    const rendered = JSON.stringify(tree.toJSON());
    // The scope commitments, unchanged in the widened sentence.
    expect(rendered).toContain('Recovery restores two things only');
    expect(rendered).toContain(
      'which devices are yours, and your findability by the email or phone number linked to your account',
    );
    expect(rendered).toContain('Your messages are not here');
    expect(rendered).toContain('a new safety number');
    tree.unmount();
  });
});

/* ── rule 3: registration stays identifier-free, structurally ──────── */

describe('registration contains zero identifier fields (rule 3), pin ON or OFF', () => {
  it('the register screen renders NO text input of any kind — with the phone pin ON', async () => {
    const tree = await render(
      <RegisterScreen onBack={jest.fn()} onRegistered={jest.fn()} />,
    );
    expect(tree.root.findAllByType(TextInput)).toHaveLength(0);
    const rendered = JSON.stringify(tree.toJSON());
    expect(rendered.includes('email-address')).toBe(false);
    expect(rendered.includes('phone-pad')).toBe(false);
    tree.unmount();
  });
});

/* ── the find flow SPEAKS the selected class ──── */

describe('find-by-phone renders phone copy, never the email surface over a phone flow', () => {
  async function type(
    tree: ReactTestRenderer.ReactTestRenderer,
    text: string,
  ): Promise<void> {
    const input = tree.root
      .findAllByProps({ testID: 'discovery-input' })
      .find(n => n.props.onChangeText !== undefined)!;
    await ReactTestRenderer.act(async () => {
      input.props.onChangeText(text);
    });
  }

  it('header, result-card trust line, and explainer all name the number class', async () => {
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(null);
    jest.spyOn(db, 'loadPhoneIdentifier').mockResolvedValue(null);
    jest
      .spyOn(accountsPhone, 'discoverySearchByPhone')
      .mockResolvedValue({ outcome: 'found', anchor: ANCHOR, deviceCount: 1 });
    const tree = await render(
      <DiscoveryScreen onBack={jest.fn()} onOpenChat={jest.fn()} />,
    );
    await press(tree, 'discovery-class-number');
    await type(tree, '+15555550100');
    await press(tree, 'discovery-search');
    await press(tree, 'discovery-info');
    const rendered = JSON.stringify(tree.toJSON());
    // The header and the input's accessibility label say what this flow IS
    // — the deck slots by reference, so a drifted screen fails here.
    expect(rendered).toContain(ACCOUNTS_PHONE_COPY.discoverTitleNumber);
    expect(rendered.includes('Find by email')).toBe(false);
    // The trust sentence names being found by phone number, never email.
    expect(rendered).toContain(ACCOUNTS_PHONE_COPY.discoverTofuNumber);
    expect(rendered.includes('being found by email')).toBe(false);
    // The explainer discusses typing a NUMBER and the CLASS-BLIND caller
    // gate — not typing and verifying an email.
    expect(rendered).toContain('typing a number would reveal');
    expect(rendered).toContain('verified email or phone number on your own account');
    expect(rendered.includes('typing an email would reveal')).toBe(false);
    tree.unmount();
  });

  it('the email class keeps its email copy beside the phone class (pin ON)', async () => {
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(null);
    jest.spyOn(db, 'loadPhoneIdentifier').mockResolvedValue(null);
    const tree = await render(
      <DiscoveryScreen onBack={jest.fn()} onOpenChat={jest.fn()} />,
    );
    await press(tree, 'discovery-info');
    const rendered = JSON.stringify(tree.toJSON());
    expect(rendered).toContain('Find by email');
    expect(rendered).toContain('typing an email would reveal');
    // The caller-gate line is class-blind under the pin (the finding-4
    // family): the gate really does accept either class.
    expect(rendered).toContain('verified email or phone number on your own account');
    tree.unmount();
  });
});

/* ── the recovery door's phone class speaks phone ── */

describe('phone recovery renders phone instructions and verbs', () => {
  it('the number class gets the text-me verb; the email class keeps the landed one', async () => {
    jest.spyOn(db, 'loadLocalRecovery').mockResolvedValue(null);
    const profile = { userId: SELF, registrationId: 7 } as unknown as db.ProfileRow;
    const tree = await render(
      <RecoveryScreen
        profile={profile}
        onBack={jest.fn()}
        onCreateIdentity={jest.fn()}
        onDone={jest.fn()}
      />,
    );
    // Email class first: the landed verb, byte-for-byte.
    expect(JSON.stringify(tree.toJSON())).toContain('Email me a recovery code');
    await press(tree, 'recovery-class-number');
    const rendered = JSON.stringify(tree.toJSON());
    expect(rendered).toContain(ACCOUNTS_PHONE_COPY.recoverRequestNumber);
    expect(rendered.includes('Email me a recovery code')).toBe(false);
    tree.unmount();
  });

  it('the narrow-scope lines widen the findability pause to the class pair (pin ON)', async () => {
    jest.spyOn(db, 'loadLocalRecovery').mockResolvedValue(null);
    const profile = { userId: SELF, registrationId: 7 } as unknown as db.ProfileRow;
    const tree = await render(
      <RecoveryScreen
        profile={profile}
        onBack={jest.fn()}
        onCreateIdentity={jest.fn()}
        onDone={jest.fn()}
      />,
    );
    await press(tree, 'recovery-info');
    const rendered = JSON.stringify(tree.toJSON());
    // The widened pause line — the cross-class cool-down said truly.
    expect(rendered).toContain(
      'being findable by the email or phone number linked to your account pauses for 7 days',
    );
    // The email-only pause sentence must not render beside it.
    expect(rendered.includes('being findable by email pauses')).toBe(false);
    // The three landed commitments survive by reference (one source).
    expect(rendered).toContain('Tacendum holds no copy of your messages');
    expect(rendered).toContain('A cancel always wins.');
    tree.unmount();
  });

  it('pre-registration, the handoff names the class pair (pin ON) — and only then', async () => {
    const tree = await render(
      <RecoveryScreen
        profile={null}
        onBack={jest.fn()}
        onCreateIdentity={jest.fn()}
        onDone={jest.fn()}
      />,
    );
    expect(JSON.stringify(tree.toJSON())).toContain(
      'Then the email or phone number linked to your old account',
    );
    tree.unmount();
    // The dark half of this assertion lives in the finding-12 suite above:
    // with the pin false, 'email or phone number' never renders.
  });
});

/* ── the REAL serializer against the shared wire
 *    schemas — body-key, class, and exactly-one-of drift all fail HERE ── */

describe('the phone payloads survive the REAL serializer against the shared wire schemas', () => {
  const realFetch = globalThis.fetch;
  let calls: { path: string; body: unknown }[];
  let nextJson: unknown;

  beforeEach(() => {
    calls = [];
    nextJson = undefined;
    globalThis.fetch = jest.fn(async (url: unknown, init?: { body?: string }) => {
      calls.push({
        path: String(url),
        body: init?.body === undefined ? undefined : JSON.parse(init.body),
      });
      return {
        ok: true,
        status: 200,
        json: async () => nextJson,
      };
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('attach request-code: {phone, class} through the phone route, class still the DEVICE slot', async () => {
    await apiRequestPhoneCode('tok', '+15555550100', 'phone');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path.endsWith('/v1/identifiers/phone/request-code')).toBe(true);
    const body = calls[0]!.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['class', 'phone']);
    // The SAME schema the server handler parses — key drift, class drift,
    // or a malformed number all fail this line.
    expect(PhoneCodeRequest.safeParse(body).success).toBe(true);
    // `class` is the landed device slot, never an identifier discriminant.
    expect(body.class).toBe('phone');
    // Teeth: an email-keyed body is NOT this wire.
    expect(
      PhoneCodeRequest.safeParse({ email: 'a@b.co', class: 'phone' }).success,
    ).toBe(false);
  });

  it('attach verify: {phone, code} through the phone route', async () => {
    await apiVerifyPhone('tok', '+15555550100', '123456');
    expect(calls[0]!.path.endsWith('/v1/identifiers/phone/verify')).toBe(true);
    const body = calls[0]!.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['code', 'phone']);
    expect(PhoneVerifyRequest.safeParse(body).success).toBe(true);
  });

  it('discovery: the ONE lookup route, exactly-one-of {phone} xor {email}, .strict()', async () => {
    nextJson = { members: [{ userId: ANCHOR, class: 'phone' }], rosterVersion: 1 };
    await apiDiscoveryLookupPhone('tok', '+15555550100');
    nextJson = { members: [{ userId: ANCHOR, class: 'phone' }], rosterVersion: 1 };
    await apiDiscoveryLookup('tok', 'alice@example.com');
    expect(calls[0]!.path.endsWith('/v1/discovery/lookup')).toBe(true);
    expect(calls[1]!.path.endsWith('/v1/discovery/lookup')).toBe(true);
    const phoneBody = calls[0]!.body as Record<string, unknown>;
    const emailBody = calls[1]!.body as Record<string, unknown>;
    expect(Object.keys(phoneBody)).toEqual(['phone']);
    expect(Object.keys(emailBody)).toEqual(['email']);
    expect(DiscoveryLookupRequest.safeParse(phoneBody).success).toBe(true);
    expect(DiscoveryLookupRequest.safeParse(emailBody).success).toBe(true);
    // Teeth, both directions: both-populated, neither, and batch-shaped
    // bodies are what the schema refuses — a client that ever emits one
    // has drifted, and this is the net that catches it.
    expect(
      DiscoveryLookupRequest.safeParse({ ...phoneBody, ...emailBody }).success,
    ).toBe(false);
    expect(DiscoveryLookupRequest.safeParse({}).success).toBe(false);
    expect(
      DiscoveryLookupRequest.safeParse({ ...emailBody, emails: ['x@y.z'] }).success,
    ).toBe(false);
  });

  it('recovery request-code: the SHARED route with the {phone} parallel field', async () => {
    await apiRecoveryRequestCodePhone('tok', '+15555550100');
    await apiRecoveryRequestCode('tok', 'alice@example.com');
    expect(calls[0]!.path.endsWith('/v1/recovery/request-code')).toBe(true);
    expect(calls[1]!.path.endsWith('/v1/recovery/request-code')).toBe(true);
    const phoneBody = calls[0]!.body as Record<string, unknown>;
    const emailBody = calls[1]!.body as Record<string, unknown>;
    expect(Object.keys(phoneBody)).toEqual(['phone']);
    expect(Object.keys(emailBody)).toEqual(['email']);
    expect(RecoveryCodeRequest.safeParse(phoneBody).success).toBe(true);
    expect(RecoveryCodeRequest.safeParse(emailBody).success).toBe(true);
    expect(
      RecoveryCodeRequest.safeParse({ ...phoneBody, ...emailBody }).success,
    ).toBe(false);
  });

  it('recovery verify: {phone, code, class} — the device-slot class beside the parallel field', async () => {
    nextJson = { groupId: GROUP, completesAt: 1 };
    await apiRecoveryVerifyPhone('tok', '+15555550100', '123456', 'phone');
    expect(calls[0]!.path.endsWith('/v1/recovery/verify')).toBe(true);
    const body = calls[0]!.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['class', 'code', 'phone']);
    expect(RecoveryVerifyRequest.safeParse(body).success).toBe(true);
    // An email joining the phone field is the drift .strict() + the
    // refinement exist to refuse.
    expect(
      RecoveryVerifyRequest.safeParse({ ...body, email: 'a@b.co' }).success,
    ).toBe(false);
  });
});

/* ── the dark pin holds on the PERSISTED row ───── */

describe('a persisted phone recovery cannot bypass the dark pin', () => {
  const phoneRow: db.LocalRecoveryRow = {
    kind: db.PHONE_KIND,
    value: '+15555550100',
    groupId: GROUP,
    completesAt: 1,
    verifiedAt: 1,
  };
  const emailRow: db.LocalRecoveryRow = { ...phoneRow, kind: db.EMAIL_KIND, value: 'a@b.co' };

  it('recoveryRowVisible: a phone row is dark under a false pin; an email row never is', () => {
    expect(accounts.recoveryRowVisible(null)).toBe(false);
    expect(accounts.recoveryRowVisible(phoneRow)).toBe(true); // pin ON
    expect(accounts.recoveryRowVisible(emailRow)).toBe(true);
    mockPhoneUiEnabled = false;
    expect(accounts.recoveryRowVisible(phoneRow)).toBe(false); // DARK
    expect(accounts.recoveryRowVisible(emailRow)).toBe(true);
  });

  it('App.tsx routes BOTH boot re-entry sites through the predicate — a bare row cannot route', () => {
    const { readFileSync } = require('fs') as {
      readFileSync: (p: string, e: string) => string;
    };
    const { join } = require('path') as { join: (...p: string[]) => string };
    const source = readFileSync(join(__dirname, '..', 'App.tsx'), 'utf8');
    // The ordinary opening AND the healed opening each gate their route on
    // the predicate — renaming or bypassing either site fails here.
    expect(source.match(/recoveryRowVisible\(pendingRecovery\)/g)).toHaveLength(1);
    expect(source.match(/recoveryRowVisible\(healedPendingRecovery\)/g)).toHaveLength(1);
  });

  it('the screen renders NOTHING of a dark phone row — no pending wait, no complete button', async () => {
    mockPhoneUiEnabled = false;
    jest.spyOn(db, 'loadLocalRecovery').mockResolvedValue(phoneRow);
    const profile = { userId: SELF, registrationId: 7 } as unknown as db.ProfileRow;
    const tree = await render(
      <RecoveryScreen
        profile={profile}
        onBack={jest.fn()}
        onCreateIdentity={jest.fn()}
        onDone={jest.fn()}
      />,
    );
    expect(tree.root.findAllByProps({ testID: 'recovery-pending' })).toHaveLength(0);
    expect(tree.root.findAllByProps({ testID: 'recovery-complete' })).toHaveLength(0);
    // The ordinary (email) entry form stands instead — the dark row is
    // invisible, not an error state.
    expect(
      tree.root.findAllByProps({ testID: 'recovery-request-code' }).length,
    ).toBeGreaterThan(0);
    const rendered = JSON.stringify(tree.toJSON());
    expect(rendered.includes('email or phone number')).toBe(false);
    expect(ULID_RE.test(rendered)).toBe(false);
    tree.unmount();
  });

  it('completion refuses a dark phone row and PRESERVES it — then completes when the pin returns (the kill-switch mirror, on the real engine)', async () => {
    await db.close();
    sqlite.__sqlite.reset();
    const engine = new DatabaseSync(':memory:');
    bindRealEngine(engine);
    db.setWorkspace('real');
    await db.initDb();
    try {
      const completesAt = Math.floor(NOW_MS / 1000) - 1; // ready by the clock
      const { deps } = realDbAccountsDeps(completesAt);
      const started = await accounts.confirmRecoveryCodeByPhone(
        '+15555550100',
        '123456',
        deps,
      );
      expect(started.outcome).toBe('pending');

      // THE FALSE-PIN BINARY: completion refuses — no group row, no
      // identifier row, and the durable recovery row survives untouched.
      mockPhoneUiEnabled = false;
      expect(await accounts.completeRecovery(deps)).toBe('failed');
      expect(
        engine.prepare('SELECT kind, value FROM recovery_local').all(),
      ).toEqual([{ kind: 'phone', value: '+15555550100' }]);
      expect(engine.prepare('SELECT * FROM account_identifier').all()).toEqual([]);

      // The pin-ON binary resumes the SAME row and completes.
      mockPhoneUiEnabled = true;
      expect(await accounts.completeRecovery(deps)).toBe('completed');
      expect(engine.prepare('SELECT * FROM recovery_local').all()).toEqual([]);
      const rows = engine
        .prepare('SELECT kind, value FROM account_identifier')
        .all();
      expect(rows).toEqual([{ kind: 'phone', value: '+15555550100' }]);
    } finally {
      await db.close();
      engine.close();
    }
  });
});

/* ── the rebuild migrations are ATOMIC ─────────── */

describe('the rebuild migrations survive a crash mid-rebuild', () => {
  it('a crash between rename and carry rolls BACK to the old shape, and the next launch migrates the data intact', async () => {
    // An earlier-era file with the landed email row and a STARTED recovery —
    // exactly the data the pre-fix crash window stranded forever.
    await db.close();
    sqlite.__sqlite.reset();
    const engine = new DatabaseSync(':memory:');
    engine.exec(`
      CREATE TABLE account_identifier (
        key TEXT PRIMARY KEY CHECK (key = 'identifier'),
        email TEXT,
        verifiedAt INTEGER,
        discoverable INTEGER NOT NULL DEFAULT 0,
        pendingEmail TEXT,
        pendingRequestedAt INTEGER,
        restoredAt INTEGER
      );
      INSERT INTO account_identifier
        (key, email, verifiedAt, discoverable, pendingEmail, pendingRequestedAt, restoredAt)
      VALUES ('identifier', 'alice@example.com', 111, 1, NULL, NULL, NULL);
      CREATE TABLE recovery_local (
        key TEXT PRIMARY KEY CHECK (key = 'recovery'),
        email TEXT NOT NULL,
        groupId TEXT NOT NULL,
        completesAt INTEGER NOT NULL,
        verifiedAt INTEGER NOT NULL
      );
      INSERT INTO recovery_local (key, email, groupId, completesAt, verifiedAt)
      VALUES ('recovery', 'alice@example.com', '${GROUP}', 999, 111);
    `);

    // A binding that DIES on the carry statement — after the rename and
    // the new CREATE, the exact window the finding names. The ROLLBACK and
    // every other statement still reach the real engine.
    let armed = true;
    const instance = sqlite.open({ name: 'tacendum.sqlite' });
    instance.execute.mockImplementation(async (sql: unknown, params?: unknown[]) => {
      if (armed && /INSERT INTO account_identifier/.test(String(sql))) {
        armed = false;
        throw new Error('injected crash: power died mid-rebuild');
      }
      const args = (params ?? []).map(p => (p === undefined ? null : p));
      const rows = engine.prepare(String(sql)).all(...args);
      const changes = engine.prepare('SELECT changes() AS c').all()[0]!.c as number;
      return { rows, rowsAffected: changes };
    });
    db.setWorkspace('real');
    await expect(db.initDb()).rejects.toThrow('injected crash');

    // ATOMICITY: the failed launch left the OLD shape — the rename undone,
    // no stranded _ac8 table, the data exactly where the next launch's
    // PRAGMA detection looks for it. Pre-fix, this state was the NEW empty
    // table beside a stranded account_identifier_ac8.
    const tables = engine
      .prepare("SELECT name FROM sqlite_master WHERE name LIKE 'account_identifier%' ORDER BY name")
      .all()
      .map(r => r.name);
    expect(tables).toEqual(['account_identifier']);
    expect(
      engine.prepare('SELECT key, email FROM account_identifier').all(),
    ).toEqual([{ key: 'identifier', email: 'alice@example.com' }]);

    // RESUMABILITY: a healthy relaunch re-detects the old shape and
    // carries every row forward.
    await db.close();
    bindRealEngine(engine);
    await db.initDb();
    try {
      expect(
        engine
          .prepare('SELECT kind, value, verifiedAt, discoverable FROM account_identifier')
          .all(),
      ).toEqual([
        { kind: 'email', value: 'alice@example.com', verifiedAt: 111, discoverable: 1 },
      ]);
      expect(
        engine.prepare('SELECT kind, value FROM recovery_local').all(),
      ).toEqual([{ kind: 'email', value: 'alice@example.com' }]);
      expect(
        engine
          .prepare("SELECT name FROM sqlite_master WHERE name LIKE '%_ac8'")
          .all(),
      ).toEqual([]);
    } finally {
      await db.close();
      engine.close();
    }
  });
});
