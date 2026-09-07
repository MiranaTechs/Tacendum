/**
 * The route table tells the truth.
 *
 * Two things are pinned here, and neither needs the app on screen:
 *
 * 1. **`backDestination` is TOTAL.** A new route must have a Back
 * destination or explicitly be a root. This switch can fail silently. A forgotten case falls to `default: return null`, and
 * then the chevron, the edge swipe and Android's hardware back all do
 * nothing while the system backgrounds the app — from a pushed surface
 * whose own Back control is right there on the glass. Nothing shouts.
 * So every route name that is not a declared ROOT must answer.
 *
 * 2. **Origins.** `profile`, `settings` and `linkConfirm` carry a `from`
 * and the table reads it, so Back returns a person to the surface they
 * actually came from rather than to a hard-coded guess.
 *
 * The name list is taken from `CALL_OVERLAY_SURFACE`, a
 * `Record<Route['name'], …>` — the compiler already refuses to build a new
 * route without a row there, so walking its keys is a list that cannot go
 * stale. The fixture map is typed the same way for the same reason: a new
 * route name does not compile until it has a concrete route here to test.
 */

import {
  CALL_OVERLAY_SURFACE,
  backDestination,
  type Route,
} from '../App';

const PEER = '01KYDBSSDJSPC9J0E5N2AWMJ5Y';
const OTHER = '01KYDBSSDJSPC9J0E5N2AWMJ60';
const MSG = '01KYDBSSDJSPC9J0E5N2AWMJ5Z';

/**
 * The ROOTS, stated explicitly rather than derived: a root is a surface the
 * system may background the app from, and that is a product decision, not a
 * property of the switch. `loading`, `locked`, `landing` and `updateRequired`
 * are pre-workspace floors; `chats` and `calls` are the two home tabs.
 */
const ROOTS: ReadonlySet<Route['name']> = new Set<Route['name']>([
  'loading',
  'locked',
  'landing',
  'updateRequired',
  'chats',
  'calls',
]);

/** One concrete, legal route per name — required fields and all. */
const FIXTURES: Record<Route['name'], Route> = {
  loading: { name: 'loading' },
  locked: { name: 'locked' },
  landing: { name: 'landing' },
  updateRequired: { name: 'updateRequired' },
  register: { name: 'register' },
  chats: { name: 'chats' },
  calls: { name: 'calls' },
  attention: { name: 'attention' },
  newChat: { name: 'newChat' },
  newRoom: { name: 'newRoom' },
  thread: { name: 'thread', peerId: PEER },
  profile: { name: 'profile' },
  settings: { name: 'settings' },
  linkedDevices: { name: 'linkedDevices' },
  linkDevice: { name: 'linkDevice' },
  linkConfirm: { name: 'linkConfirm' },
  accountEmail: { name: 'accountEmail' },
  accountPhone: { name: 'accountPhone' },
  accountUsername: { name: 'accountUsername' },
  discover: { name: 'discover' },
  recover: { name: 'recover' },
  peerProfile: { name: 'peerProfile', peerId: PEER },
  groupProfile: { name: 'groupProfile', groupId: OTHER },
  photoViewer: { name: 'photoViewer', peerId: PEER, msgId: MSG, direction: 'in' },
};

const NAMES = Object.keys(CALL_OVERLAY_SURFACE) as Array<Route['name']>;

test('the fixture map covers exactly the route union, so the sweep below is not partial', () => {
  // Both sides are Records over Route['name'], so this is a runtime echo of
  // a compile-time fact — worth having anyway, because a future hand-widened
  // type on either map would silently shrink the sweep to nothing.
  expect([...NAMES].sort()).toEqual(
    (Object.keys(FIXTURES) as Array<Route['name']>).sort(),
  );
  expect(NAMES.length).toBeGreaterThan(20);
});

test('backDestination is total: every pushed surface answers, every root yields', () => {
  // The regression this catches, stated once: add a route, wire its push
  // site, forget this switch, and the new screen has a working chevron
  // (its own onBack prop) while hardware back BACKGROUNDS the app from it.
  // The failure is invisible on iOS and silent on Android.
  const silent: string[] = [];
  for (const name of NAMES) {
    const destination = backDestination(FIXTURES[name]);
    if (ROOTS.has(name)) {
      expect([name, destination]).toEqual([name, null]);
    } else if (destination === null) {
      silent.push(name);
    }
  }
  expect(silent).toEqual([]);
});

test('a route name with no case is REJECTED by the same predicate — the falsifier', () => {
  // CONTRIBUTING.md:76-80. Feed a planted name through the real function:
  // if this returned a destination the sweep above could not fail, and a
  // green run would mean nothing.
  const planted = { name: 'notARoute' } as unknown as Route;
  expect(backDestination(planted)).toBeNull();
});

describe('origins: Back returns to the surface a person actually came from', () => {
  test('a profile opened from Calls pops to calls; from Chats, to chats', () => {
    expect(backDestination({ name: 'profile', from: 'calls' })).toEqual({
      name: 'calls',
    });
    expect(backDestination({ name: 'profile', from: 'chats' })).toEqual({
      name: 'chats',
    });
    // No origin: the chat list, which is where every unmarked door was.
    expect(backDestination({ name: 'profile' })).toEqual({ name: 'chats' });
  });

  test('Settings pops to chats when the App Lock nudge sent it there, to profile otherwise', () => {
    // The nudge routes chats → settings. Before this, Back from it landed a
    // person on a Profile screen they never asked for, and the transition
    // ran backwards (depth 3 → 2) into it.
    expect(backDestination({ name: 'settings', from: 'chats' })).toEqual({
      name: 'chats',
    });
    expect(backDestination({ name: 'settings', from: 'profile' })).toEqual({
      name: 'profile',
    });
    expect(backDestination({ name: 'settings' })).toEqual({ name: 'profile' });
  });

  test('Account pages return to their Settings category and email verification returns to Username', () => {
    expect(backDestination({ name: 'accountUsername', from: 'profile' })).toEqual({
      name: 'settings', from: 'profile', section: 'account',
    });
    // The old router skipped the form the person was trying to complete.
    expect(backDestination({ name: 'accountEmail', from: 'profile', via: 'username' })).toEqual({
      name: 'accountUsername', from: 'profile',
    });
  });

  test('the link-offer confirm pops to the home surface it arrived over', () => {
    expect(backDestination({ name: 'linkConfirm', from: 'calls' })).toEqual({
      name: 'calls',
    });
    expect(backDestination({ name: 'linkConfirm', from: 'chats' })).toEqual({
      name: 'chats',
    });
    expect(backDestination({ name: 'linkConfirm' })).toEqual({ name: 'chats' });
  });

  test('Account returns through Settings home and preserves where Settings was opened', () => {
    const devices = backDestination({ name: 'linkedDevices', from: 'chats' });
    expect(devices).toEqual({ name: 'settings', from: 'chats', section: 'account' });
    const settingsHome = backDestination(devices!);
    expect(settingsHome).toEqual({ name: 'settings', from: 'chats' });
    expect(backDestination(settingsHome!)).toEqual({ name: 'chats' });

    // The Account category and Settings home unwind before Profile.
    const viaProfile = backDestination({
      name: 'linkedDevices',
      from: 'profile',
    });
    expect(viaProfile).toEqual({ name: 'settings', from: 'profile', section: 'account' });
    expect(backDestination(backDestination(viaProfile!)!)).toEqual({ name: 'profile' });

    // An unmarked account page still returns to the Account category.
    expect(backDestination({ name: 'linkedDevices' })).toEqual({
      name: 'settings', section: 'account',
    });
  });

  test('EVERY Settings sub-screen carries the origin, not only the one that was checked', () => {
    // Four doors leave Settings, and a fix that mended one of them would
    // leave the same defect behind three others.
    const subScreens = [
      'linkedDevices',
      'accountEmail',
      'accountPhone',
      'accountUsername',
    ] as const;
    for (const name of subScreens) {
      expect([name, backDestination({ name, from: 'chats' })]).toEqual([
        name,
        { name: 'settings', from: 'chats', section: 'account' },
      ]);
    }
    // Linking a device sits one deeper again: it pops to the roster, and the
    // roster must still know where Settings was entered from.
    expect(backDestination({ name: 'linkDevice', from: 'chats' })).toEqual({
      name: 'linkedDevices',
      from: 'chats',
    });
  });

  test('an origin is a FIELD on an existing name, never a new route name', () => {
    // `visibleSurface.ts` classifies by route NAME, so the 23-name matrix
    // must not have moved. Its own suite proves the cells; this proves the
    // count — a new name added here would have to register in eleven places.
    expect(NAMES).toHaveLength(24);
  });
});
