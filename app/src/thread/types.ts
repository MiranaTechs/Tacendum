// The three shapes the conversation screen keeps in local state, lifted out
// of ChatThreadScreen.tsx: which
// drawer is open, what the composer is doing besides writing something new,
// and what a reaction rail was opened to do. Comments included.
//
// The db type is imported as a TYPE ONLY, so this module loads nothing at
// runtime. Import direction is one-way: nothing here comes from
// `../screens/`.
import { type MessageRow } from '../db';

export type Drawer = 'none' | 'attach' | 'emoji';

/**
 * What the composer is doing besides writing something new. Both states hold
 * the row they act on, so the composer can name it and the send path knows
 * which verb to use.
 */
export type Pending =
  | { kind: 'reply'; row: MessageRow }
  | { kind: 'edit'; row: MessageRow };

/** What a rail was opened to do, so VoiceOver's Delete reaches the confirm. */
export type RailIntent = 'react' | 'delete';
