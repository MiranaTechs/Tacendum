/**
 * The thread's small pure helpers, tested DIRECTLY for the first time
 *: the filename sanitiser, the two number
 * formatters, the tick mapping, the inbound-arrival order, and the
 * jumbo-emoji predicate.
 *
 * The sharpest of them is `safeFileName`. A filename arrives from a PEER,
 * and a bidi override reverses the visible extension — "photo<U+202E>gnp.exe"
 * reads as "photo.png" on glass. This is the only test in the tree that asks
 * it directly.
 *
 * Falsifier (CONTRIBUTING.md:76-80): run against deliberately broken
 * predicates before it was believed — see the commit body.
 */
import type { MessageRow } from '../src/db';
import {
  clockDuration,
  formatBytes,
  isEmojiOnly,
  laterArrival,
  newestInboundOf,
  quiet,
  safeFileName,
  tickStatusOf,
} from '../src/thread/format';

const row = (over: Partial<MessageRow> & Pick<MessageRow, 'msgId'>): MessageRow => ({
  peerId: 'p1',
  direction: 'in',
  body: '',
  ts: 0,
  status: 'received',
  ...over,
});

describe('safeFileName makes a peer-controlled name safe to draw', () => {
  test('a bidi override that reverses the extension is stripped', () => {
    // What the attack looks like: the override makes 'gnp.exe' read 'exe.png'.
    const attack = 'photo\u202Egnp.exe';
    expect(safeFileName(attack)).toBe('photognp.exe');
    expect(safeFileName(attack)).not.toContain('\u202E');
  });

  test('every bidi embedding, isolate, zero-width and control character goes', () => {
    const name = 'a\u200Bb\u200Ec\u202Ad\u2066e\u0000f\u007Fg\u009Fh.txt';
    expect(safeFileName(name)).toBe('abcdefgh.txt');
  });

  test('a newline cannot break out of the row', () => {
    expect(safeFileName('one\ntwo.pdf')).toBe('onetwo.pdf');
  });

  test('a name that sanitises away, or arrives empty, falls back to a word', () => {
    expect(safeFileName('\u202E\u200B  ')).toBe('Document');
    expect(safeFileName('')).toBe('Document');
    expect(safeFileName('   ')).toBe('Document');
  });

  test('an ordinary name is left exactly alone, accents included', () => {
    expect(safeFileName('Rapport financier 2026 — final.pdf')).toBe(
      'Rapport financier 2026 — final.pdf',
    );
  });
});

describe('formatBytes: one decimal above a megabyte, none below', () => {
  test.each([
    [0, '0 B'],
    [512, '512 B'],
    [1023, '1023 B'],
    [1024, '1 KB'],
    [412 * 1024, '412 KB'],
    [1024 * 1024, '1.0 MB'],
    [Math.round(3.25 * 1024 * 1024), '3.3 MB'],
  ])('%i bytes reads %s', (n, expected) => {
    expect(formatBytes(n)).toBe(expected);
  });
});

describe('clockDuration is m:ss, and never negative', () => {
  test.each([
    [0, '0:00'],
    [7, '0:07'],
    [59, '0:59'],
    [60, '1:00'],
    [605, '10:05'],
    [-4, '0:00'],
  ])('%i seconds reads %s', (sec, expected) => {
    expect(clockDuration(sec)).toBe(expected);
  });

  test('a fractional second rounds rather than truncating into a lie', () => {
    expect(clockDuration(59.6)).toBe('1:00');
  });
});

describe('tickStatusOf keeps a state that draws nothing out of the tick', () => {
  test('the three states a tick can draw pass through', () => {
    expect(tickStatusOf('sent')).toBe('sent');
    expect(tickStatusOf('delivered')).toBe('delivered');
    expect(tickStatusOf('read')).toBe('read');
    expect(tickStatusOf('pending')).toBe('pending');
  });

  test('received and error map to the state that draws nothing', () => {
    expect(tickStatusOf('received')).toBe('pending');
    expect(tickStatusOf('error')).toBe('pending');
  });
});

describe('the newest inbound row is found by arrival order, not by count', () => {
  test('later ts wins; a tie is broken by msgId, the list order itself', () => {
    expect(laterArrival({ ts: 2, msgId: 'a' }, { ts: 1, msgId: 'z' })).toBe(true);
    expect(laterArrival({ ts: 1, msgId: 'z' }, { ts: 2, msgId: 'a' })).toBe(false);
    expect(laterArrival({ ts: 1, msgId: 'b' }, { ts: 1, msgId: 'a' })).toBe(true);
    expect(laterArrival({ ts: 1, msgId: 'a' }, { ts: 1, msgId: 'a' })).toBe(false);
  });

  test('outbound rows are never the mark', () => {
    expect(
      newestInboundOf([
        row({ msgId: 'm1', ts: 10 }),
        row({ msgId: 'm2', ts: 99, direction: 'out' }),
      ]),
    ).toEqual({ ts: 10, msgId: 'm1' });
  });

  test('a thread with nothing inbound has no mark at all', () => {
    expect(
      newestInboundOf([row({ msgId: 'm1', ts: 1, direction: 'out' })]),
    ).toBeNull();
    expect(newestInboundOf([])).toBeNull();
  });

  test('rows are not assumed sorted', () => {
    expect(
      newestInboundOf([
        row({ msgId: 'm3', ts: 30 }),
        row({ msgId: 'm1', ts: 10 }),
        row({ msgId: 'm2', ts: 20 }),
      ]),
    ).toEqual({ ts: 30, msgId: 'm3' });
  });
});

describe('isEmojiOnly: one to three emoji and nothing else', () => {
  test('one, two and three emoji are jumbo', () => {
    expect(isEmojiOnly('❤️')).toBe(true);
    expect(isEmojiOnly('😂🔥')).toBe(true);
    expect(isEmojiOnly('👍 😮 😢')).toBe(true);
  });

  test('four is a message again', () => {
    expect(isEmojiOnly('😀😂❤️👍')).toBe(false);
  });

  test('a letter, a digit or punctuation anywhere makes it a sentence', () => {
    expect(isEmojiOnly('❤️ you')).toBe(false);
    expect(isEmojiOnly('ok 👍')).toBe(false);
    expect(isEmojiOnly('👍!')).toBe(false);
    expect(isEmojiOnly('9️⃣ 9')).toBe(false);
  });

  test('nothing at all, and whitespace alone, are not emoji', () => {
    expect(isEmojiOnly('')).toBe(false);
    expect(isEmojiOnly('   ')).toBe(false);
  });

  test('a ZWJ sequence and a flag each count as ONE', () => {
    expect(isEmojiOnly('👩‍👩‍👧‍👦')).toBe(true);
    expect(isEmojiOnly('🇪🇹🇺🇸🇫🇷')).toBe(true);
    expect(isEmojiOnly('🇪🇹🇺🇸🇫🇷🇯🇵')).toBe(false);
  });

  test('a skin tone rides its base rather than counting again', () => {
    expect(isEmojiOnly('👍🏽👍🏿👍🏻')).toBe(true);
  });
});

describe('quiet swallows a rejection a torn-down screen can do nothing about', () => {
  test('a resolved promise still reaches the continuation', async () => {
    const seen: number[] = [];
    quiet(Promise.resolve(7), v => seen.push(v));
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual([7]);
  });

  test('a rejection neither throws nor reaches the continuation', async () => {
    const seen: number[] = [];
    // If this escaped, the relock path would red-box on its way out.
    expect(() =>
      quiet(Promise.reject(new Error('connection closed')), v => seen.push(v)),
    ).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual([]);
  });

  test('no continuation at all is allowed', async () => {
    expect(() => quiet(Promise.resolve(1))).not.toThrow();
    await Promise.resolve();
  });
});
