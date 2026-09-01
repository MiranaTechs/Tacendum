import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrivateKey } from '@signalapp/libsignal-client';

const home = mkdtempSync(join(tmpdir(), 'tacendum-contacts-'));
process.env.TACENDUM_HOME = home;

const { FileStores } = await import('../src/stores.js');
const { MessageLog } = await import('../src/msglog.js');
const { listContacts } = await import('../src/contacts.js');
const { address } = await import('../src/messaging.js');

// All three are legal user ids (Crockford base32 — no I, L, O, U): the
// roster filters on id shape, so a fixture with an illegal letter would be
// silently dropped and the test would be asserting about the filter instead.
const CHANGED_PEER = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const NAMED_PEER = '01BQBBQBBQBBQBBQBBQBBQBBQB';
const LOG_ONLY_PEER = '01CCCCCCCCCCCCCCCCCCCCCCCC';

/**
 * The roster is assembled entirely from local state — the
 * TOFU pins, the pending-change record `trust` runs on, the names carried by
 * profile envelopes, and the message log — because the question it answers ("who
 * is this, and do I still believe it?") is exactly the question the server
 * must not be allowed to answer.
 */
describe('the contact roster', () => {
  it('reports trust, names and last-message time from local state only', async () => {
    const stores = new FileStores('roster');
    const log = new MessageLog('roster');

    // Two pinned peers, one of which later warns of an identity change.
    await stores.identity.saveIdentity(address(CHANGED_PEER), PrivateKey.generate().getPublicKey());
    await stores.identity.saveIdentity(address(NAMED_PEER), PrivateKey.generate().getPublicKey());
    stores.markIdentityChange(CHANGED_PEER);
    stores.setPeerName(NAMED_PEER, 'CI — api-server');

    // Log traffic: the named peer twice (latest must win), and a peer known
    // ONLY from the log — e.g. un-pinned by `trust`, not yet re-pinned.
    log.append({ id: '01H00000000000000000000001', dir: 'in', peer: NAMED_PEER, ts: 1000, tcm: '', text: 'a', read: false });
    log.append({ id: '01H00000000000000000000002', dir: 'in', peer: NAMED_PEER, ts: 2000, tcm: '', text: 'b', read: false });
    log.append({ id: '01H00000000000000000000003', dir: 'in', peer: LOG_ONLY_PEER, ts: 3000, tcm: '', text: 'c', read: false });

    const rows = listContacts('roster');
    expect(rows.map(r => r.userId)).toEqual([LOG_ONLY_PEER, NAMED_PEER, CHANGED_PEER]);

    const [logOnly, named, changed] = rows;
    // A pending change OUTRANKS the pin — "pinned" about a peer the client is
    // refusing to decrypt would say the opposite of the warning.
    expect(changed).toMatchObject({ trust: 'changed' });
    expect(changed?.lastMessageAt).toBeUndefined();
    expect(named).toMatchObject({ trust: 'pinned', name: 'CI — api-server', lastMessageAt: 2000 });
    expect(logOnly).toMatchObject({ trust: 'unverified', lastMessageAt: 3000 });
    expect(logOnly?.name).toBeUndefined();
  });

  it('ignores a stray non-id file in the identities directory', () => {
    const stores = new FileStores('stray');
    // The directory IS the store, so anything can end up in it; a row must
    // require an id-shaped name, not merely a .pub suffix.
    writeFileSync(join(stores.root, 'identities', 'not-an-id.1.pub'), 'x', { mode: 0o600 });
    expect(listContacts('stray')).toEqual([]);
  });

  it('is empty for a client that has never heard from anyone', () => {
    new FileStores('hermit');
    expect(listContacts('hermit')).toEqual([]);
  });
});
