/**
 * Bundled corpus for the decoy generator — data only.
 * Names read like an ordinary contact list; syllables compose pronounceable
 * pseudo-words that read like language and mean nothing. Nothing here is
 * derived from, or ever compared against, real user data.
 */

export const FIRST_NAMES = [
  'Ava', 'Ben', 'Carmen', 'Dana', 'Eli', 'Farah', 'Gus', 'Hana',
  'Iris', 'Jonas', 'Kira', 'Leo', 'Mara', 'Nico', 'Omar', 'Priya',
  'Quinn', 'Rosa', 'Sam', 'Tessa', 'Uri', 'Vera', 'Wes', 'Ximena',
  'Yara', 'Zeke', 'Alba', 'Bruno', 'Celia', 'Dario', 'Edith', 'Felix',
  'Greta', 'Hugo', 'Ines', 'Jules', 'Katya', 'Lior', 'Marta', 'Nadia',
  'Otto', 'Paloma', 'Ravi', 'Sofia', 'Tomas', 'Una', 'Viktor', 'Willa',
] as const;

export const LAST_NAMES = [
  'Alder', 'Barros', 'Calloway', 'Dietrich', 'Egan', 'Fontaine',
  'Guerra', 'Holt', 'Ibarra', 'Jensen', 'Kaplan', 'Larsen',
  'Marsh', 'Novak', 'Okafor', 'Petrov', 'Quiroga', 'Reyes',
  'Sandoval', 'Tran', 'Ulman', 'Vance', 'Whitfield', 'Yun',
  'Zamora', 'Beck', 'Costa', 'Dunn', 'Ferro', 'Grady',
  'Hale', 'Mercer',
] as const;

/** Building blocks for pseudo-words. Lowercase a-z only — a verification
 * regex decomposes every generated word back into this set. */
export const SYLLABLES = [
  'va', 'shen', 'tol', 'mir', 'kel', 'lun', 'dei', 'pra', 'os', 'tem',
  'ri', 'gon', 'sa', 'vel', 'nor', 'dri', 'pel', 'ank', 'kor', 'mi',
  'tas', 'en', 'lor', 'bas', 'sin', 'ur', 'fen', 'ap', 'zol', 'ne',
  'gar', 'ith', 'om', 'bre', 'ul', 'das',
] as const;

export const EMOJI = ['😂', '👍', '❤️', '😅', '🙌', '😴', '☕', '🌙'] as const;
