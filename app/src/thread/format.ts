// Pure conversation helpers: safe filenames, byte and duration formatting,
// quiet database work, delivery ticks, arrival order and emoji-only detection.
// Type-only imports keep the module independent of a database or screen.
import { type MessageRow, type MessageStatus } from '../db';
import { type TickStatus } from '../ui/TickGlyph';

/**
 * A peer-controlled filename, made safe to DRAW.
 *
 * Two attacks, both classic and both cheap to close: bidirectional control
 * characters reverse the visible extension (U+202E turns "photo\u202Egnp.exe"
 * into something that reads as "photo.png"), and control characters or
 * newlines break out of the row's shape. Stripped, not escaped — there is no
 * legitimate filename that needs them, and the sanitised name is what the
 * QuickLook title shows too.
 */
export function safeFileName(name: string): string {
  const stripped = name
    // Bidi overrides/embeddings/isolates, zero-width, and C0/C1 controls.
    // eslint-disable-next-line no-control-regex
.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .trim();
  return stripped.length > 0 ? stripped : 'Document';
}

/** '3.2 MB' / '412 KB' — one decimal above a megabyte, none below. */
export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/** m:ss for a duration in seconds. */
export function clockDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Fire-and-forget database work.
 *
 * A relock closes the connection BEFORE the route changes,
 * so a debounced requery, a draft flush or an opened-at stamp can legitimately
 * arrive after the latch is on. The latch has already guaranteed the work went
 * nowhere — swallowing the rejection only stops a screen that is being torn
 * down from red-boxing on its way out.
 */
export function quiet<T>(work: Promise<T>, then?: (value: T) => void): void {
  work.then(value => then?.(value)).catch(() => {});
}

/**
 * The delivery state a tick can draw.
 * `received` is an inbound state and `error` renders the failed bubble, so
 * neither reaches a tick; they map to the state that draws nothing rather
 * than being cast past the type — a new MessageStatus fails here at compile
 * time instead of on glass.
 */
export function tickStatusOf(status: MessageStatus): TickStatus {
  return status === 'received' || status === 'error' ? 'pending' : status;
}

/** The identity of the newest inbound row: the "New messages" register
 * compares this, never a row count. */
export interface InboundMark {
  ts: number;
  msgId: string;
}

/** `a` is a later arrival than `b` — by the sender's clock, then by id, the
 * same order the list itself is sorted in. */
export function laterArrival(a: InboundMark, b: InboundMark): boolean {
  return a.ts > b.ts || (a.ts === b.ts && a.msgId > b.msgId);
}

/** The newest inbound row on glass, or null when there is none. */
export function newestInboundOf(rows: MessageRow[]): InboundMark | null {
  let newest: InboundMark | null = null;
  for (const row of rows) {
    if (row.direction !== 'in') continue;
    if (newest === null || laterArrival(row, newest)) {
      newest = { ts: row.ts, msgId: row.msgId };
    }
  }
  return newest;
}

/**
 * One emoji as the eye counts it: a pictographic base with any skin tone,
 * presentation selector or keycap, joined to further bases by ZWJ — or a
 * flag, which is two regional indicators. Built once and guarded: a JS
 * engine without Unicode property escapes simply never draws jumbo emoji,
 * it does not fail to draw the thread.
 */
const EMOJI_UNIT = (() => {
  try {
    const base =
      '\\p{Extended_Pictographic}(?:\\p{Emoji_Modifier}|\\uFE0F|\\u20E3)*';
    return new RegExp(
      `(?:${base}(?:\\u200D${base})*|\\p{Regional_Indicator}{2})`,
      'gu',
    );
  } catch {
    return null;
  }
})();

/** At most this many emoji, and nothing else, draw at display size. */
const JUMBO_EMOJI_MAX = 3;

/**
 * Whether a message is one to three emoji and nothing else. Spaces between them are allowed; any letter, digit or
 * mark that is not part of an emoji is a sentence, and a sentence keeps its
 * bubble.
 */
export function isEmojiOnly(text: string): boolean {
  if (EMOJI_UNIT === null) return false;
  const packed = text.replace(/\s+/g, '');
  if (packed === '') return false;
  const units = packed.match(EMOJI_UNIT);
  return (
    units !== null &&
    units.length <= JUMBO_EMOJI_MAX &&
    units.join('') === packed
  );
}
