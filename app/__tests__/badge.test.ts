import { setBadgeCount } from 'tacendum-call';
import * as crypto from 'tacendum-crypto';
import { clearBadge, syncBadge } from '../src/badge';
import * as db from '../src/db';

/**
 * The number on the app icon.
 *
 * The server raises it from the delivery-queue depth, because when the app is
 * not running nothing else can. The app owns it whenever it IS running, and
 * these are the rules for that: it is this device's unread total, it comes
 * from whichever workspace is open, and a database that cannot be read leaves
 * the previous number alone rather than lying with a zero.
 */

jest.mock('../src/db', () => ({ unreadCounts: jest.fn() }));

const unreadCounts = db.unreadCounts as jest.MockedFunction<
  typeof db.unreadCounts
>;
const badge = setBadgeCount as jest.MockedFunction<typeof setBadgeCount>;

const shared = (crypto as unknown as { __sharedState: Map<string, string> })
  .__sharedState;

beforeEach(() => {
  jest.clearAllMocks();
  shared.clear();
});

describe('syncBadge', () => {
  it('is the sum across every conversation, not the number of conversations', async () => {
    unreadCounts.mockResolvedValue({ 'peer-a': 3, 'peer-b': 1, 'peer-c': 7 });

    await syncBadge();

    expect(badge).toHaveBeenCalledWith(11);
  });

  it('clears the icon when nothing is unread', async () => {
    // The case that matters most: the server set a number while the app was
    // dead, the user then read everything, and only this call removes it. The
    // server never learns anyone looked, so it can never clear it itself.
    unreadCounts.mockResolvedValue({});

    await syncBadge();

    expect(badge).toHaveBeenCalledWith(0);
  });

  it('leaves the previous number alone when the database cannot be read', async () => {
    // A stale count is a smaller lie than a zero over a phone with unread
    // messages — and this runs on a backgrounding path, where the database may
    // already be closing.
    unreadCounts.mockRejectedValue(new Error('database is closed'));

    await expect(syncBadge()).resolves.toBeUndefined();

    expect(badge).not.toHaveBeenCalled();
  });

  it('never rejects when the native call fails', async () => {
    // Called from teardown and from background transitions. A badge is not
    // worth failing either of them.
    unreadCounts.mockResolvedValue({ 'peer-a': 2 });
    badge.mockRejectedValueOnce(new Error('not authorised'));

    await expect(syncBadge()).resolves.toBeUndefined();
  });
});

describe('the files the extension does arithmetic with', () => {
  it('sync rewrites base and RESETS the extension counter', async () => {
    // badge = base + extra, computed by the extension per push. The app owns
    // the truth: recomputing rewrites base and deletes extra, so any drift
    // the counter accumulated self-heals here.
    unreadCounts.mockResolvedValue({ 'peer-a': 4 });
    shared.set('badge-extra', '7');

    await syncBadge();

    expect(shared.get('badge-base')).toBe('4');
    expect(shared.has('badge-extra')).toBe(false);
  });

  it('a failed file write does not fail the badge itself', async () => {
    unreadCounts.mockResolvedValue({ 'peer-a': 2 });
    (crypto.writeSharedState as jest.Mock).mockRejectedValueOnce(
      new Error('container unavailable'),
    );

    await expect(syncBadge()).resolves.toBeUndefined();
    expect(badge).toHaveBeenCalledWith(2);
  });

  it('clear zeroes base and deletes extra — or the next push resurrects the number', async () => {
    shared.set('badge-base', '9');
    shared.set('badge-extra', '3');

    await clearBadge();

    expect(shared.get('badge-base')).toBe('0');
    expect(shared.has('badge-extra')).toBe(false);
  });
});

describe('clearBadge', () => {
  it('zeroes the icon without reading the database', async () => {
    // The duress path calls this BEFORE the decoy workspace opens, while the
    // real workspace's count is still on the icon. Consulting the database
    // there would either read the real count — the exact thing being hidden —
    // or fail, and `syncBadge`'s fail-safe is to leave the number showing.
    await clearBadge();

    expect(badge).toHaveBeenCalledWith(0);
    expect(unreadCounts).not.toHaveBeenCalled();
  });

  it('never rejects', async () => {
    badge.mockRejectedValueOnce(new Error('not authorised'));

    await expect(clearBadge()).resolves.toBeUndefined();
  });
});
