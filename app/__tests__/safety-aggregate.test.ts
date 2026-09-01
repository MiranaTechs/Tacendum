/**
 * THE MULTI-DEVICE SAFETY AGGREGATE:
 * safety numbers stay per-device-pair under the hood, and the chat-level
 * state is the WORST across the peer's devices — the header never pretends
 * one number covers three devices. Plus the `deviceAdded` finding class:
 * below 'changed' when cross-signed, AS 'changed' when not.
 */

import {
  aggregateSafetyStates,
  deviceAddedStateFor,
  SAFETY_COPY,
  SAFETY_PRECEDENCE,
  SAFETY_STATUS,
  safetyStateFor,
  type SafetyState,
} from '../src/safety';

describe('aggregateSafetyStates — worst across device pairs', () => {
  it('a matched pair beside a changed pair renders "changed"', () => {
    expect(aggregateSafetyStates(['matched', 'changed'])).toBe('changed');
    expect(aggregateSafetyStates(['changed', 'matched'])).toBe('changed');
  });

  it('is the worst by the pinned precedence, whatever the order', () => {
    expect(aggregateSafetyStates(['unchecked', 'matched'])).toBe('matched');
    expect(aggregateSafetyStates(['matched', 'none'])).toBe('none');
    expect(aggregateSafetyStates(['none', 'mismatched'])).toBe('mismatched');
    expect(aggregateSafetyStates(['mismatched', 'deviceAdded'])).toBe('deviceAdded');
    expect(aggregateSafetyStates(['deviceAdded', 'changed'])).toBe('changed');
    expect(
      aggregateSafetyStates(['unchecked', 'matched', 'deviceAdded', 'mismatched']),
    ).toBe('deviceAdded');
  });

  it('one pair aggregates to itself; no pairs to "none"', () => {
    for (const state of SAFETY_PRECEDENCE) {
      expect(aggregateSafetyStates([state])).toBe(state);
    }
    expect(aggregateSafetyStates([])).toBe('none');
  });

  it('the precedence is exactly the pinned order, worst first', () => {
    expect(SAFETY_PRECEDENCE).toEqual([
      'changed',
      'deviceAdded',
      'mismatched',
      'none',
      'matched',
      'unchecked',
    ]);
  });
});

describe('the deviceAdded finding class', () => {
  it('ranks below changed when cross-signed, AS changed when not', () => {
    expect(deviceAddedStateFor(true)).toBe('deviceAdded');
    expect(deviceAddedStateFor(false)).toBe('changed');
    // "Below changed": a changed pair still outranks it in the aggregate.
    expect(
      aggregateSafetyStates([deviceAddedStateFor(true), 'changed']),
    ).toBe('changed');
  });

  it('carries a full status + copy entry like every other state', () => {
    expect(SAFETY_STATUS.deviceAdded).toEqual({
      rule: 'warningMark',
      ink: 'warningInk',
    });
    const copy = SAFETY_COPY.deviceAdded;
    expect(copy.label.length).toBeGreaterThan(0);
    expect(copy.body('Maya')).toContain('Maya');
    // A review item, never a block: sending continues.
    expect(copy.blocked).toBeNull();
  });

  it('safetyStateFor still answers the per-pair states it always did', () => {
    // The pair-level machine is untouched — deviceAdded is a ROSTER finding
    // folded in by the aggregate, never a pair state safetyStateFor mints.
    const states: SafetyState[] = [
      safetyStateFor({ blocked: true, safety: 'x', checkedAt: null, mismatchAt: null }),
      safetyStateFor({ blocked: false, safety: 'x', checkedAt: 1, mismatchAt: null }),
    ];
    expect(states).toEqual(['changed', 'matched']);
    expect(aggregateSafetyStates([...states, deviceAddedStateFor(true)])).toBe('changed');
  });
});
