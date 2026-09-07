import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { AiNotifyPreferenceSchema, type AiNotifyPreference } from '@tacendum/shared';
import { stateDir } from './config.js';
import { withFileLock } from './lock.js';
import { writeFileAtomic } from './stores.js';

const StoredNotifyPreferenceSchema = AiNotifyPreferenceSchema.extend({ v: z.literal(1) }).strict();

export type RoutineNotifyPreference = { routine: 'all' } | { q: string; routine: 'all' | 'quiet' };

export function notifyPreferencePath(account: string): string {
  return join(stateDir(account), 'ai-notify-preference.json');
}

const notifyPreferenceLockPath = (account: string): string =>
  join(stateDir(account), 'ai-notify-preference.lock');

function readStored(account: string): z.infer<typeof StoredNotifyPreferenceSchema> | null {
  try {
    return StoredNotifyPreferenceSchema.parse(
      JSON.parse(readFileSync(notifyPreferencePath(account), 'utf8')),
    );
  } catch {
    return null;
  }
}

/** Missing or damaged state preserves the historical notifying default. */
export function readRoutineNotifyPreference(account: string): RoutineNotifyPreference {
  const stored = readStored(account);
  return stored === null ? { routine: 'all' } : { q: stored.q, routine: stored.routine };
}

function preferenceFromProfile(body: string): AiNotifyPreference | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const profile = parsed as Record<string, unknown>;
  if (profile.tcm !== 'profile') return null;
  const preference = AiNotifyPreferenceSchema.safeParse(profile.notifyPref);
  return preference.success ? preference.data : null;
}

/**
 * Apply one authenticated owner request and return the effective pair to ack.
 * ULIDs provide the request order. A delayed older frame can therefore re-ack
 * the current value after an ack loss, but cannot roll it back. Reusing one q
 * with another value never rebinds that request.
 */
export function applyOwnerNotifyPreference(
  account: string,
  sender: string,
  owner: string | undefined,
  body: string,
): AiNotifyPreference | null {
  if (owner === undefined || sender !== owner) return null;
  const requested = preferenceFromProfile(body);
  if (requested === null) return null;
  mkdirSync(stateDir(account), { recursive: true, mode: 0o700 });
  return withFileLock(notifyPreferenceLockPath(account), () => {
    const current = readStored(account);
    if (current !== null && current.q >= requested.q) {
      return { q: current.q, routine: current.routine };
    }
    writeFileAtomic(notifyPreferencePath(account), `${JSON.stringify({ v: 1, ...requested })}\n`, {
      mode: 0o600,
    });
    return requested;
  });
}

/**
 * `v:0` makes the carrier inert for ordinary newest-profile application.
 * The app consumes `notifyPrefAck` independently and binds it to peer+q+mode.
 */
export function composeNotifyPreferenceAck(preference: AiNotifyPreference): string {
  const checked = AiNotifyPreferenceSchema.parse(preference);
  return JSON.stringify({
    tcm: 'profile',
    n: '',
    a: '',
    v: 0,
    notifyPrefAck: checked,
  });
}
