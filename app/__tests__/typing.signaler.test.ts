import {
  createTypingSignaler,
  TYPING_EXPIRY_MS,
  TYPING_REFRESH_MS,
} from '../src/typing';

describe('typing cadence', () => {
  function harness(startMs = 1_000_000) {
    let nowMs = startMs;
    const sent: Array<'start' | 'stop'> = [];
    const signaler = createTypingSignaler(state => sent.push(state), () => nowMs);
    return { sent, signaler, advance: (ms: number) => { nowMs += ms; } };
  }

  test('the invariant the receiver depends on: refresh < expiry', () => {
    expect(TYPING_REFRESH_MS).toBeLessThan(TYPING_EXPIRY_MS);
  });

  test('first keystroke sends start; further keystrokes inside the window send nothing', () => {
    const { sent, signaler, advance } = harness();
    signaler.onDraftChange(true);
    advance(1_000);
    signaler.onDraftChange(true);
    advance(1_000);
    signaler.onDraftChange(true);
    expect(sent).toEqual(['start']);
  });

  test('a keystroke at the refresh boundary re-sends start', () => {
    const { sent, signaler, advance } = harness();
    signaler.onDraftChange(true);
    advance(TYPING_REFRESH_MS - 1);
    signaler.onDraftChange(true);
    expect(sent).toEqual(['start']);
    advance(1);
    signaler.onDraftChange(true);
    expect(sent).toEqual(['start', 'start']);
  });

  test('emptying the draft sends stop exactly once', () => {
    const { sent, signaler } = harness();
    signaler.onDraftChange(true);
    signaler.onDraftChange(false);
    signaler.onDraftChange(false);
    expect(sent).toEqual(['start', 'stop']);
  });

  test('stop() while inactive sends nothing', () => {
    const { sent, signaler } = harness();
    signaler.stop();
    expect(sent).toEqual([]);
  });

  test('stop() after composing sends stop once; a new keystroke starts fresh immediately', () => {
    const { sent, signaler } = harness();
    signaler.onDraftChange(true);
    signaler.stop();
    signaler.stop();
    signaler.onDraftChange(true);
    expect(sent).toEqual(['start', 'stop', 'start']);
  });

  test('an initial empty draft sends nothing', () => {
    const { sent, signaler } = harness();
    signaler.onDraftChange(false);
    expect(sent).toEqual([]);
  });
});
