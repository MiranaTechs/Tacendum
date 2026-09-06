import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A confirmation that says its piece and goes.
 *
 * "App Lock is on." is worth reading for a moment and worth nothing three
 * minutes later, when the person is doing something else entirely and the
 * sentence is still sitting on the screen claiming to describe now. Settings
 * holds four such lines and clears none of them; two profile screens each
 * hand-roll the same timer separately. This is that timer, once.
 *
 * ```ts
 * const notice = useTransientNotice();
 * notice.show('App Lock is on.');
 * // …
 * {notice.notice ? (
 *   <InlineNotice message={notice.notice} seq={notice.seq} testID="settings-notice" />
 * ) : null}
 * ```
 *
 * `seq` increments on every show, so saying the same thing twice re-announces
 * it — `InlineNotice` and `InlineError` already take `seq` for exactly that.
 *
 * **Undo, when a screen wants one**, is this hook plus the `action` slot
 * `InlineNotice` already carries:
 *
 * The example strings here are the shipped ones, deliberately: this docstring
 * is what the next notice gets copied from, so it says `conversation` — the
 * body noun the chat list's own deck uses ("Conversation deleted.", "Delete
 * conversation") — and not `chat`.
 *
 * ```ts
 * notice.show('Conversation deleted.');
 * <InlineNotice
 *   message={notice.notice}
 *   seq={notice.seq}
 *   action={{ label: 'Undo', onPress: restore, testID: 'undo-delete' }}
 * />
 * ```
 *
 * In layout, announced, self-clearing — and deliberately **not a toast**. This
 * product keeps notices in the layout, consistent with `InlineError`.
 * So a floating one is not a thing to invent here later: an Undo that needs
 * more room than the notice has belongs in the layout, not over it.
 *
 * Adoption is optional for surfaces that already work; **any new notice uses
 * this** rather than a fifth hand-rolled timer.
 *
 * @param ms how long the message stays. 3 s is long enough to read a short
 *   sentence and short enough that it cannot be mistaken for state.
 */
export function useTransientNotice(ms = 3000): {
  notice: string | null;
  show: (message: string) => void;
  clear: () => void;
  seq: number;
} {
  const [notice, setNotice] = useState<string | null>(null);
  const [seq, setSeq] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stop = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  /** Take the message away now — a screen leaving a step it belonged to. */
  const clear = useCallback(() => {
    stop();
    setNotice(null);
  }, [stop]);

  const show = useCallback(
    (message: string) => {
      // The running timer goes first: without this, Save-then-Save-again
      // shows the second message and takes it away on the first one's clock.
      stop();
      setNotice(message);
      setSeq(n => n + 1);
      timer.current = setTimeout(() => {
        timer.current = null;
        setNotice(null);
      }, ms);
    },
    [ms, stop],
  );

  // Unmounting is the other way a notice ends. A timer that outlives the tree
  // sets state on nothing and, in this suite, keeps a test alive after it.
  useEffect(() => stop, [stop]);

  return { notice, show, clear, seq };
}
