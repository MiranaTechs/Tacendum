import { z } from 'zod';
import { Ulid } from './group-fold.js';

/**
 * Owner-controlled delivery preference carried inside an authenticated,
 * encrypted profile envelope. The same bounded pair is used for the request
 * and acknowledgement; direction and authenticated peer decide its meaning.
 */
export const AiNotifyPreferenceSchema = z
  .object({
    q: Ulid,
    routine: z.enum(['all', 'quiet']),
  })
  .strict();

export type AiNotifyPreference = z.infer<typeof AiNotifyPreferenceSchema>;

/** Receive fragment: a future or malformed preference costs only itself. */
export const aiNotifyPreference = AiNotifyPreferenceSchema.optional().catch(undefined);
