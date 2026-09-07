import type { ReactionRow } from '../src/db';
import { groupReactions } from '../src/thread/reactions';

const reaction = (
  emoji: string,
  reactorId: string,
  direction: 'in' | 'out' = 'in',
  ts = 1,
): ReactionRow => ({
  targetMsgId: 'message-1',
  targetDirection: 'in',
  direction,
  reactorId,
  emoji,
  ts,
});

describe('groupReactions', () => {
  test('one emoji becomes one stable group with a count and local ownership', () => {
    expect(
      groupReactions([
        reaction('👍', 'ana'),
        reaction('❤️', 'cara'),
        reaction('❤️', '', 'out'),
        reaction('❤️', 'ben'),
      ]),
    ).toEqual([
      {
        emoji: '❤️',
        count: 3,
        includesMine: true,
        reactions: [
          reaction('❤️', '', 'out'),
          reaction('❤️', 'ben'),
          reaction('❤️', 'cara'),
        ],
      },
      {
        emoji: '👍',
        count: 1,
        includesMine: false,
        reactions: [reaction('👍', 'ana')],
      },
    ]);
  });

  test('unknown emoji stay visible after the familiar choices, sorted deterministically', () => {
    expect(
      groupReactions([
        reaction('🫖', 'ana', 'in', 9),
        reaction('✨', 'cara', 'in', 3),
        reaction('', 'gone', 'in', 10),
      ]).map(group => group.emoji),
    ).toEqual(['✨', '🫖']);
  });
});


test('duplicate delivery and a replaced reaction count each authenticated reactor once', () => {
  const rows = [reaction('❤️', 'ana', 'in', 1), reaction('❤️', 'ana', 'in', 1),
    reaction('👍', 'ana', 'in', 2), reaction('❤️', '', 'out', 1),
    reaction('❤️', '', 'out', 1)];
  const summary = groupReactions(rows).map(({ emoji, count, includesMine }) => ({ emoji, count, includesMine }));
  expect(summary).toEqual([
    { emoji: '❤️', count: 1, includesMine: true },
    { emoji: '👍', count: 1, includesMine: false },
  ]);
  expect(groupReactions([...rows].reverse())).toEqual(groupReactions(rows));
});
