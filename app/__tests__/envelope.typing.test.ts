import {
  encodeEnvelope,
  isCarrierEnvelope,
  parseEnvelope,
  type TypingEnvelope,
} from '../src/envelope';

/**
 * x.typing is the first occupant of the reserved `x.` carrier namespace.
 * These tests pin the round-trip, the carrier classification (which must
 * hold by PREFIX, so future x.typing variants stay invisible to this build
 * too), and the schema's refusal of malformed state.
 */

describe('x.typing envelope', () => {
  test('round-trips through encode/parse for a 1:1', () => {
    const env: TypingEnvelope = { tcm: 'x.typing', state: 'start' };
    expect(parseEnvelope(encodeEnvelope(env))).toEqual(env);
  });

  test('round-trips with a room scope', () => {
    const env: TypingEnvelope = {
      tcm: 'x.typing',
      state: 'stop',
      room: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    };
    expect(parseEnvelope(encodeEnvelope(env))).toEqual(env);
  });

  test('is a carrier: never a message row, never a preview', () => {
    expect(isCarrierEnvelope('{"tcm":"x.typing","state":"start"}')).toBe(true);
  });

  test('a future x.* shape this build cannot parse is STILL a carrier (prefix routing)', () => {
    expect(isCarrierEnvelope('{"tcm":"x.typing2","zap":1}')).toBe(true);
    expect(parseEnvelope('{"tcm":"x.typing2","zap":1}')).toBeNull();
  });

  test('rejects a state outside start|stop', () => {
    expect(parseEnvelope('{"tcm":"x.typing","state":"maybe"}')).toBeNull();
  });

  test('rejects a missing state', () => {
    expect(parseEnvelope('{"tcm":"x.typing"}')).toBeNull();
  });
});
