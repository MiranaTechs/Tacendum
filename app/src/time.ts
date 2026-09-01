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

/** A thread's date divider: `Today`, `Yesterday`, else a short date. */
export function dayLabel(ts: number): string {
  const d = new Date(ts);
  const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
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
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'short' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
