/**
 * The time labels the app writes on conversations and messages. Lifted out of
 * the two screens that each carried their own copy: a day divider and a chat
 * row that disagree about where "yesterday" ends is a bug nobody would ever
 * report, and locale-formatted output is only comparable if it comes from one
 * place. Behaviour is unchanged from the originals.
 */

/** Whether two instants fall on the same calendar day, locally. */
export function sameDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return (
    x.getFullYear() === y.getFullYear() &&
    x.getMonth() === y.getMonth() &&
    x.getDate() === y.getDate()
  );
}

const startOfDay = (x: Date) =>
  new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();

/**
 * The short-date options, plus the year when the date is not from this year.
 *
 * Without it a message from March 2024 read "Mar 3" and sorted, silently,
 * between two dates from this year — the reader had no way to tell an old
 * thread from a current one. The comparison is on the calendar year rather
 * than on an age in days, because "which year am I reading" is the question
 * a bare "Mar 3" fails to answer, and a fixed window would answer it wrongly
 * every January. No new string: the locale renders the year it already knows
 * how to render, so there is nothing here for the copy scanner to cover.
 */
function shortDateOptions(d: Date): Intl.DateTimeFormatOptions {
  const options: Intl.DateTimeFormatOptions = {
    month: 'short',
    day: 'numeric',
  };
  if (d.getFullYear() !== new Date().getFullYear()) options.year = 'numeric';
  return options;
}

/** A thread's date divider: `Today`, `Yesterday`, else a short date. */
export function dayLabel(ts: number): string {
  const d = new Date(ts);
  const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, shortDateOptions(d));
}

/** Clock time on a message, in the reader's locale. */
export function clockLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Compact recency: clock time today, weekday within a week, else short date. */
export function timeLabel(ts: number): string {
  const d = new Date(ts);
  const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86400000);
  if (days <= 0) {
    return d.toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });
  }
  // The weekday branch is deliberately NOT year-qualified: a row three days
  // old can fall in the previous calendar year, and "Mon 2026" is not a
  // thing anyone writes. Only the branch that shows a date shows the year.
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'short' });
  return d.toLocaleDateString(undefined, shortDateOptions(d));
}
