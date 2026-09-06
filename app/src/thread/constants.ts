// Conversation constants: reactions, composer choices, grouping and debounce
// intervals, attachment explanations and spoken delivery states. The screen
// owns its copy deck, including platform-specific device wording. This module
// imports nothing, keeping dependencies one-way.

/** Tapback choices, with the words VoiceOver should say for each. */
export const REACTIONS: { emoji: string; label: string }[] = [
  { emoji: '❤️', label: 'React with heart' },
  { emoji: '👍', label: 'React with thumbs up' },
  { emoji: '😂', label: 'React with laughing face' },
  { emoji: '😮', label: 'React with surprised face' },
  { emoji: '😢', label: 'React with sad face' },
  { emoji: '🔥', label: 'React with fire' },
];

/**
 * The same six as words, for a reaction ALREADY on a message. A peer can send
 * any string up to 16 characters, so anything outside the six falls back to
 * reading the character itself.
 */
export const REACTION_WORD: Record<string, string> = {
  '❤️': 'heart',
  '👍': 'thumbs up',
  '😂': 'laughing face',
  '😮': 'surprised face',
  '😢': 'sad face',
  '🔥': 'fire',
};

/** Composer emoji drawer: eight, scannable, not a wrapped buffet. */
export const QUICK_EMOJI = ['😀', '😂', '❤️', '👍', '🙏', '🎉', '😢', '✨'];

/** Consecutive same-direction messages inside this window render as a group. */
export const GROUP_WINDOW_MS = 5 * 60 * 1000;

/** Scrolling this far dismisses an open reaction rail. */
export const RAIL_DISMISS_SCROLL = 24;

/**
 * How close to the end still counts as "reading the newest message". Auto
 * scrolling is conditioned on this: an unconditional scroll-to-end makes
 * history unreadable and closes the reaction rail the instant it opens.
 */
export const BOTTOM_SLACK = 24;

/** How long the row a tapped quote led to stays washed pine. */
export const QUOTE_FLASH_MS = 600;

/** Trailing debounce on draft writes — one row per pause, not per keystroke. */
export const DRAFT_SAVE_MS = 400;

/** A burst of downloads or receipts must coalesce into one requery. */
export const REFRESH_DEBOUNCE_MS = 80;

/** How long the message strip confirms a copy before returning to detail. */
export const COPIED_MS = 2000;

/** Character counts at which the composer starts, then escalates, a warning. */
export const COUNTER_WARN = 3500;
export const COUNTER_DANGER = 4500;

/** Longer than this, a name in the placeholder wraps the composer to two lines. */
export const PLACEHOLDER_NAME_MAX = 18;

/**
 * Longest @-query the picker chases before deciding the '@' was prose.
 * Names may contain spaces, so the query is not stopped at the first one —
 * the picker simply closes when nothing matches any more.
 */
export const MENTION_QUERY_MAX = 32;

/**
 * The mention picker scrolls inside this height rather than growing past it:
 * it sits over a keyboard, and at accessibility text sizes the rows GROW —
 * fewer are visible and the list scrolls, which is the no-clipping posture
 * the emoji drawer and the safety panel already take.
 */
export const MENTION_PICKER_MAX_HEIGHT = 216;

/** Behind the attach drawer's ⓘ: the two
 * promises the tiles could be read as making, stated where they are asked
 * for rather than printed under the grid on every open. */
export const ATTACH_ABOUT = [
  'Photos you take here aren’t saved to your Photos.',
  'Your location is read once, only when you tap Location.',
] as const;

/** What VoiceOver says for a delivery state — never punctuation names. */
export const STATUS_WORD: Record<string, string> = {
  pending: 'Sending',
  sent: 'Sent',
  delivered: 'Delivered',
  // The only status that came from the other PERSON rather than from the
  // server, and the only one they can switch off.
  read: 'Read',
  received: 'Received',
};
