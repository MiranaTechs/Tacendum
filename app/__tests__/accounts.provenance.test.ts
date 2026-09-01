/**
 * THE DISCOVERY TAP RECORDS ITS PROVENANCE. `startDiscoveredChat` is the ONE creation path both shipped
 * discovery classes share (email and phone: DiscoveryScreen calls it for
 * either), so the mark is made here and nowhere else in the flow.
 *
 * What these pin:
 *  - the tap creates the chat with `introducedBy: 'discovery'`;
 *  - the mark is CLIENT-ONLY: the tap touches no api function at all, and
 *    the lookup that preceded it still sends exactly the bytes it sent
 *    before this phase — `(token, normalizedEmail)` and nothing more. The
 *    fake api below is the spy; every entry records, none is expected.
 */
import * as accounts from '../src/accounts';

/** The lookup's wire answer, typed by the api dep it feeds. */
type DiscoveryLookupResponse = Awaited<
  ReturnType<accounts.AccountsDeps['api']['discoveryLookup']>
>;

const ANCHOR = '01HQZZZZ00000000000000000A';
const NOW_MS = 1_756_000_000_000;

function fakeDeps() {
  /** Every api call, by name and arguments — the spy the wire assertion reads. */
  const apiCalls: Array<[string, unknown[]]> = [];
  const upserts: unknown[][] = [];
  const labels: unknown[][] = [];
  const record =
    <T>(name: string, answer: T) =>
    async (...args: unknown[]): Promise<T> => {
      apiCalls.push([name, args]);
      return answer;
    };
  const lookup: DiscoveryLookupResponse = {
    members: [{ userId: ANCHOR, class: 'phone' }],
    rosterVersion: 1,
  };
  const deps: accounts.AccountsDeps = {
    api: {
      emailRequestCode: record('emailRequestCode', undefined),
      emailVerify: record('emailVerify', undefined),
      emailUnlink: record('emailUnlink', undefined),
      setDiscoverable: record('setDiscoverable', undefined),
      discoveryLookup: record('discoveryLookup', lookup),
      recoveryRequestCode: record('recoveryRequestCode', undefined),
      recoveryVerify: record('recoveryVerify', { groupId: ANCHOR, completesAt: 0 }),
      recoveryRequestCodePhone: record('recoveryRequestCodePhone', undefined),
      recoveryVerifyPhone: record('recoveryVerifyPhone', {
        groupId: ANCHOR,
        completesAt: 0,
      }),
      recoveryCancel: record('recoveryCancel', undefined),
      recoveryComplete: record('recoveryComplete', undefined),
      authChallenge: record('authChallenge', { challenge: 'AAAA' }),
      getPrekeyBundle: async (...args: unknown[]) => {
        apiCalls.push(['getPrekeyBundle', args]);
        throw new Error('not served in this suite');
      },
    },
    crypto: {
      identityPublicKey: async () => 'IDKEY',
      signAuthChallenge: async c => `sig(${c})`,
    },
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
      setLocalName: async (...args: unknown[]) => {
        labels.push(args);
      },
      loadLinkGroup: async () => null,
      saveLinkGroup: async () => undefined,
      upsertLinkedDevice: async () => undefined,
    },
    dissolve: async () => undefined,
    token: async () => 'bearer',
    selfId: async () => '01HQSELF000000000000000000',
    now: () => NOW_MS,
  };
  return { deps, apiCalls, upserts, labels };
}

describe('startDiscoveredChat (the result-card tap)', () => {
  it('creates the chat marked as a server introduction', async () => {
    const { deps, upserts } = fakeDeps();
    await accounts.startDiscoveredChat('Alice@Example.com', ANCHOR, deps);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]![0]).toBe(ANCHOR);
    expect(upserts[0]![2]).toBe('discovery');
  });

  it('still labels the chat with the typed text, exactly as before the mark existed', async () => {
    const { deps, labels } = fakeDeps();
    await accounts.startDiscoveredChat('Alice@Example.com', ANCHOR, deps);
    expect(labels).toEqual([[ANCHOR, 'Alice@Example.com']]);
  });

  it('touches NO api function — provenance is a local fact, never a wire one', async () => {
    const { deps, apiCalls } = fakeDeps();
    await accounts.startDiscoveredChat('Alice@Example.com', ANCHOR, deps);
    expect(apiCalls).toEqual([]);
  });
});

describe('the lookup that precedes the tap — api spy fixture', () => {
  it('sends exactly the pre-phase bytes: (token, normalized email), nothing more', async () => {
    const { deps, apiCalls } = fakeDeps();
    const outcome = await accounts.discoverySearch('  Alice@Example.COM ', deps);
    expect(outcome).toEqual({ outcome: 'found', anchor: ANCHOR, deviceCount: 1 });
    // The fixture, verbatim: one call, two positional arguments, no third.
    expect(apiCalls).toEqual([['discoveryLookup', ['bearer', 'alice@example.com']]]);
  });
});
