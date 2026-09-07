import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AiNotifyPreferenceSchema } from '@tacendum/shared';
import {
  applyOwnerNotifyPreference,
  composeNotifyPreferenceAck,
  notifyPreferencePath,
  readRoutineNotifyPreference,
} from '../src/ai-notify-preference.js';

const OWNER = '01J00000000000000000000000';
const OTHER = '01J00000000000000000000001';
const Q1 = '01J00000000000000000000010';
const Q2 = '01J00000000000000000000020';

const request = (q: string, routine: 'all' | 'quiet'): string =>
  JSON.stringify({ tcm: 'profile', n: 'Owner', a: '', v: 7, notifyPref: { q, routine } });

describe('owner AI notification preference', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'tacendum-ai-pref-'));
    process.env.TACENDUM_HOME = home;
  });
  afterEach(() => {
    delete process.env.TACENDUM_HOME;
  });

  it('defaults to all and persists a validated owner request at mode 0600', () => {
    expect(readRoutineNotifyPreference('agent')).toEqual({ routine: 'all' });
    expect(applyOwnerNotifyPreference('agent', OWNER, OWNER, request(Q1, 'quiet'))).toEqual({
      q: Q1,
      routine: 'quiet',
    });
    expect(readRoutineNotifyPreference('agent')).toEqual({ q: Q1, routine: 'quiet' });
    expect(statSync(notifyPreferencePath('agent')).mode & 0o777).toBe(0o600);
  });

  it('ignores a non-owner or malformed optional field without changing state', () => {
    expect(applyOwnerNotifyPreference('agent', OTHER, OWNER, request(Q1, 'quiet'))).toBeNull();
    expect(
      applyOwnerNotifyPreference(
        'agent',
        OWNER,
        OWNER,
        JSON.stringify({ tcm: 'profile', notifyPref: { q: Q1, routine: 'future' } }),
      ),
    ).toBeNull();
    expect(readRoutineNotifyPreference('agent')).toEqual({ routine: 'all' });
  });

  it('does not let a stale queued request overwrite a newer effective setting', () => {
    expect(applyOwnerNotifyPreference('agent', OWNER, OWNER, request(Q2, 'quiet'))).toEqual({
      q: Q2,
      routine: 'quiet',
    });
    // The late Q1 request re-acks the effective Q2 value so a lost Q2 ack can
    // still converge, but it cannot roll the setting back.
    expect(applyOwnerNotifyPreference('agent', OWNER, OWNER, request(Q1, 'all'))).toEqual({
      q: Q2,
      routine: 'quiet',
    });
    expect(readRoutineNotifyPreference('agent')).toEqual({ q: Q2, routine: 'quiet' });
  });

  it('retries the same q idempotently and never rebinds it to another value', () => {
    applyOwnerNotifyPreference('agent', OWNER, OWNER, request(Q1, 'quiet'));
    const before = readFileSync(notifyPreferencePath('agent'), 'utf8');
    expect(applyOwnerNotifyPreference('agent', OWNER, OWNER, request(Q1, 'quiet'))).toEqual({
      q: Q1,
      routine: 'quiet',
    });
    expect(applyOwnerNotifyPreference('agent', OWNER, OWNER, request(Q1, 'all'))).toEqual({
      q: Q1,
      routine: 'quiet',
    });
    expect(readFileSync(notifyPreferencePath('agent'), 'utf8')).toBe(before);
  });

  it('composes an inert profile carrier whose ack is the exact applied pair', () => {
    const body = composeNotifyPreferenceAck({ q: Q2, routine: 'all' });
    const parsed = JSON.parse(body) as Record<string, unknown>;
    expect(parsed).toEqual({
      tcm: 'profile',
      n: '',
      a: '',
      v: 0,
      notifyPrefAck: { q: Q2, routine: 'all' },
    });
    expect(AiNotifyPreferenceSchema.parse(parsed.notifyPrefAck)).toEqual({
      q: Q2,
      routine: 'all',
    });
  });
});
