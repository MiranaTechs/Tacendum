import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const home = mkdtempSync(join(tmpdir(), 'tacendum-room-msgid-'));
process.env.TACENDUM_HOME = home;

const { cmdRoom } = await import('../src/room-commands.js');
type RoomDelivery = import('../src/room-commands.js').RoomDelivery;
type FanoutLeg = import('../src/send.js').FanoutLeg;
const { saveProfile } = await import('../src/profile.js');
const { Reporter } = await import('../src/output.js');

/**
 * THE WIRE-MSGID REGRESSION, AGAINST THE CLI'S SEND PATH.
 *
 * A fan-out minted with a monotonic ULID factory hands the server N
 * consecutive base-32 integers under one senderId, written into N recipient
 * partitions it keeps for 30 days — a free, exact, durable, retroactive JOIN
 * KEY over room membership. That is the one leak this feature could
 * introduce, the CLI was the client still minting monotonic ids when the
 * plan was ratified (`monotonicFactory()` in what is now send.ts), and a
 * refactor that "simplifies" the minter back is exactly how it returns. So:
 * 1 000 fan-outs of 11 legs each, driven through the REAL `room send`
 * command against real room files, asserting on the wire ids the transport
 * was handed —
 *
 *   - every id is 26 chars of the ULID alphabet with first char 0-7
 *     (decodable as a 128-bit ULID under any decoder);
 *   - within one fan-out, no two ids share more than 6 leading characters
 *     (no timestamp prefix exists to exempt — a 7-char share is chance at
 *     ≈2⁻³³ per fan-out, ≈10⁻⁵ across the run);
 *   - within one fan-out, no two ids are adjacent under base-32 successor
 *     (the monotonic factory's signature).
 *
 * Non-vacuity was proven by execution: swapping the room legs' minter to the
 * monotonic `innerUlid` makes this fail on the first fan-out. If it goes red
 * again, the minter has been swapped back — fix the minter, never this test.
 */

const ANA = '01ANAANAANAANAANAANAANAANA';
saveProfile({
  name: 'ana',
  identityKey: 'test-key',
  userId: ANA,
  authToken: 'test-token',
  registrationId: 1,
  deviceId: 1,
});

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function memberId(i: number): string {
  return `01MMMMMMMMMMMMMMMMMMMMMMM${ALPHABET[i] as string}`;
}

function sharedPrefixLen(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/** The base-32 successor of a Crockford string, with carry. */
function successor(id: string): string {
  const chars = id.split('');
  for (let i = chars.length - 1; i >= 0; i--) {
    const value = ALPHABET.indexOf(chars[i] as string);
    if (value < 31) {
      chars[i] = ALPHABET[value + 1] as string;
      return chars.join('');
    }
    chars[i] = ALPHABET[0] as string; // carry
  }
  return chars.join('');
}

describe('CSPRNG wire ids on the CLI room send path', () => {
  it('1 000 fan-outs: pure-CSPRNG wire ids, ≤6 shared leading chars, no base-32 adjacency', async () => {
    const members = Array.from({ length: 11 }, (_, i) => memberId(i));
    const fanouts: string[][] = [];
    const deliver: RoomDelivery = (async ({ legs }: { legs: FanoutLeg[] }) => {
      fanouts.push(legs.map(l => l.msgId));
      return legs.map(l => ({ to: l.to, msgId: l.msgId, state: 'delivered' as const }));
    }) as RoomDelivery;

    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    let gid = '';
    try {
      const report = new Reporter({ json: true, plain: true });
      await cmdRoom(['create', 'ana', 'Crowd', ...members], report, deliver);
      const { listRooms } = await import('../src/rooms.js');
      gid = listRooms('ana')[0]?.groupId ?? '';
      expect(gid).not.toBe('');
      fanouts.length = 0; // the creation fan-out is not under test here

      for (let i = 0; i < 1000; i++) {
        await cmdRoom(['send', 'ana', gid, 'x'], report, deliver);
      }
    } finally {
      spy.mockRestore();
    }

    expect(fanouts).toHaveLength(1000);
    for (const ids of fanouts) {
      expect(ids).toHaveLength(11);
      for (const id of ids) {
        expect(id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
      }
      for (let a = 0; a < ids.length; a++) {
        for (let b = a + 1; b < ids.length; b++) {
          const x = ids[a] as string;
          const y = ids[b] as string;
          expect(sharedPrefixLen(x, y)).toBeLessThanOrEqual(6);
          expect(successor(x)).not.toBe(y);
          expect(successor(y)).not.toBe(x);
        }
      }
    }
  }, 120_000);
});
