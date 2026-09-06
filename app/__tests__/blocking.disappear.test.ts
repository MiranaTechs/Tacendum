/**
 * THE TIMER LISTS, PROVEN AGAINST THE SHIPPED SCHEMAS.
 *
 * The 1:1 timer and the room timer ride different wires, and for one release
 * they were rendered from one array. `TimerEnvelope.s` is capped at four
 * weeks (`app/src/envelope.ts`); `GroupSettingsEnvelope.s` is capped at
 * `TIMER_MAX_SECONDS` — SEVEN DAYS (`packages/shared/src/group-envelope.ts`).
 * A "4 weeks" chip in a room would emit `s: 2419200`, which every client
 * including build 26 rejects on a strict `.parse()`, with no OTA to fix it;
 * and room timers merge by MINIMUM, so a four-week room value would have no
 * meaning in the fold either. Hence two lists.
 *
 * The point of this file is that "the wire permits it" is a CHECKED FACT and
 * not a sentence in a plan: every option in each list is fed to the schema
 * its own screen sends it through, and the four-week value is fed to the room
 * schema as the falsifier. If someone widens a list past its wire, this file
 * goes red before a person ever sees the chip.
 */

import { GroupSettingsEnvelope } from '@tacendum/shared/group-envelope';
import {
  DISAPPEAR,
  DISAPPEAR_OPTIONS_PEER,
  DISAPPEAR_OPTIONS_ROOM,
  ROOM_TIMER_MAX_SECONDS,
  disappearLabel,
} from '../src/blocking';
import { TimerEnvelope } from '../src/envelope';

/** Any room id: the schema wants a ULID and this test is about `s`. */
const ROOM = '01BX5ZZKBKACTAV9WEVGEMMVRZ';

/** Four weeks — legal in a 1:1, past the room cap. */
const FOUR_WEEKS = 28 * 24 * 60 * 60;

describe('the two lists', () => {
  it('offers six choices on the 1:1 surface, shortest first, four weeks last', () => {
    expect(DISAPPEAR_OPTIONS_PEER.map(o => o.label)).toEqual([
      'Off',
      '5 minutes',
      '1 hour',
      '1 day',
      '1 week',
      '4 weeks',
    ]);
    expect(DISAPPEAR_OPTIONS_PEER.map(o => o.seconds)).toEqual([
      0,
      300,
      3600,
      86400,
      604800,
      FOUR_WEEKS,
    ]);
  });

  it('offers the same list in a room, minus the one the room wire refuses', () => {
    expect(DISAPPEAR_OPTIONS_ROOM.map(o => o.label)).toEqual([
      'Off',
      '5 minutes',
      '1 hour',
      '1 day',
      '1 week',
    ]);
  });

  it('the room list is the peer list under the room CAP, not the first N of it', () => {
    // The bug this replaces: `slice(0, 5)` states the ceiling as a POSITION.
    // Insert a '30 minutes' option anywhere in the peer list and the room
    // silently loses '1 week' while every assertion above stays green.
    for (const option of DISAPPEAR_OPTIONS_ROOM) {
      expect([option.label, option.seconds <= ROOM_TIMER_MAX_SECONDS]).toEqual([
        option.label,
        true,
      ]);
    }
    // Nothing the room wire would carry is dropped from the room's list.
    for (const option of DISAPPEAR_OPTIONS_PEER) {
      if (option.seconds > ROOM_TIMER_MAX_SECONDS) continue;
      expect([option.label, DISAPPEAR_OPTIONS_ROOM.includes(option)]).toEqual([
        option.label,
        true,
      ]);
    }
    // And the split is real: the 1:1 list carries something the room cannot.
    expect(
      DISAPPEAR_OPTIONS_PEER.some(o => o.seconds > ROOM_TIMER_MAX_SECONDS),
    ).toBe(true);
  });

  it('THE CAP IS THE WIRE’S OWN, to the second — the falsifier for the mirror', () => {
    // `TIMER_MAX_SECONDS` is not exported from the shared package, so
    // blocking.ts holds a mirror of it. A mirror is only safe if it is
    // checked: the room schema must accept exactly this value and refuse the
    // next second, so drift in EITHER direction goes red here rather than in
    // a room where a setting silently fails to travel.
    const at = (s: number) =>
      GroupSettingsEnvelope.safeParse({ tcm: 'grp.set', g: ROOM, s, n: 1 })
        .success;
    expect(at(ROOM_TIMER_MAX_SECONDS)).toBe(true);
    expect(at(ROOM_TIMER_MAX_SECONDS + 1)).toBe(false);
  });

  it('stops at five minutes — 30 seconds is refused', () => {
    const shortest = DISAPPEAR_OPTIONS_PEER.map(o => o.seconds)
      .filter(s => s > 0)
      .sort((a, b) => a - b)[0];
    expect(shortest).toBe(300);
  });
});

describe('every option parses on the wire its own screen sends it through', () => {
  it.each(DISAPPEAR_OPTIONS_PEER.map(o => [o.label, o.seconds] as const))(
    '1:1 %s parses as a TimerEnvelope',
    (_label, seconds) => {
      expect(
        TimerEnvelope.safeParse({ tcm: 'timer', s: seconds, v: 1 }).success,
      ).toBe(true);
    },
  );

  it.each(DISAPPEAR_OPTIONS_ROOM.map(o => [o.label, o.seconds] as const))(
    'room %s parses as a GroupSettingsEnvelope',
    (_label, seconds) => {
      expect(
        GroupSettingsEnvelope.safeParse({
          tcm: 'grp.set',
          g: ROOM,
          s: seconds,
          n: 1,
        }).success,
      ).toBe(true);
    },
  );

  it('THE FALSIFIER: four weeks in a room is refused by the shipped schema', () => {
    // The whole reason the lists are two. This must stay false until
    // TIMER_MAX_SECONDS is raised in a client-first wire release of its own.
    expect(
      GroupSettingsEnvelope.safeParse({
        tcm: 'grp.set',
        g: ROOM,
        s: FOUR_WEEKS,
        n: 1,
      }).success,
    ).toBe(false);
    // And it is legal on the surface that does ship it, so the split is a
    // wire fact and not caution.
    expect(
      TimerEnvelope.safeParse({ tcm: 'timer', s: FOUR_WEEKS, v: 1 }).success,
    ).toBe(true);
  });
});

describe('disappearLabel', () => {
  it('resolves over the union, so a value set on either surface reads in words', () => {
    for (const option of DISAPPEAR_OPTIONS_PEER) {
      if (option.seconds === 0) continue;
      expect(disappearLabel(option.seconds)).toBe(option.label);
    }
  });

  it('says nothing at all when the timer is off', () => {
    expect(disappearLabel(0)).toBeNull();
    expect(disappearLabel(null)).toBeNull();
    expect(disappearLabel(undefined)).toBeNull();
    expect(disappearLabel(-1)).toBeNull();
  });

  it('reads an unknown value in words rather than as "300s"', () => {
    // A peer on another build may have set anything the wire allows. The
    // status sentence lowercases whatever comes back, so it has to be words.
    expect(disappearLabel(30)).toBe('30 seconds');
    expect(disappearLabel(1)).toBe('1 second');
    expect(disappearLabel(15 * 60)).toBe('15 minutes');
    expect(disappearLabel(12 * 60 * 60)).toBe('12 hours');
    expect(disappearLabel(3 * 24 * 60 * 60)).toBe('3 days');
    expect(disappearLabel(2 * 7 * 24 * 60 * 60)).toBe('2 weeks');
    // Nothing anywhere reads as a bare seconds count.
    for (const seconds of [30, 90, 1000, 15 * 60, 2419200]) {
      expect(disappearLabel(seconds)).not.toMatch(/^\d+s$/);
    }
  });

  it('reads a value that is not a whole unit exactly, never rounded into a claim', () => {
    // 90 seconds is a minute and a half; calling it "2 minutes" would be the
    // status line overstating a shared setting neither person chose.
    expect(disappearLabel(90)).toBe('90 seconds');
    expect(disappearLabel(1000)).toBe('1000 seconds');
  });

  it('reads well inside the status sentence, which lowercases it', () => {
    expect(DISAPPEAR.status(disappearLabel(300)!)).toBe(
      'Messages here disappear after 5 minutes.',
    );
    expect(DISAPPEAR.status(disappearLabel(FOUR_WEEKS)!)).toBe(
      'Messages here disappear after 4 weeks.',
    );
  });
});
