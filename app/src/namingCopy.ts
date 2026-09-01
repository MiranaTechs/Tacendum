import { DEVICE_NOUN } from './deviceNoun';

/**
 * The naming-moment copy deck — one PURE
 * module for the two surfaces that ask the question: the skippable step
 * after a successful registration (NamingScreen) and the one-time nudge the
 * chat list's empty state gives an existing nameless account. The
 * linkingCopy.ts discipline: no api, no db, no react-native beyond the noun
 * token, so device-noun.test.ts can load it per idiom.
 *
 * TERMINOLOGY PIN: the display layer ships as "name". It is a
 * *name*, not a handle — no `@` sigil, no promise of uniqueness, no way to be
 * found by it. The teaching sentence behind the ⓘ says so in plain words, and
 * it stays true after the unique finding label ships: the display name and the unique
 * finding label are separate things, and this deck describes the display
 * name only.
 */
export const NAMING_COPY = {
  title: 'What should people call you?',
  lead: 'The people you chat with see this instead of the tail of your ID. You can change it any time from your profile.',
  fieldLabel: 'Name',
  placeholder: 'Your name',
  continue: 'Use this name',
  saving: 'Saving…',
  skip: 'Not now',
  /** The ⓘ: where the name goes, and — as load-bearing — where it does not. */
  infoLabel: 'Where this name goes',
  infoLines: [
    `This name is stored on your ${DEVICE_NOUN} and shared, end-to-end encrypted, only with people you chat with. Our server never sees it. It is not unique and nobody can search for it.`,
  ],
  saveFailed: 'Your name wasn’t saved. Try again.',

  /* ── the one-time nudge (ChatListScreen's empty state) ─────────────── */
  /** One sentence: what the person looks like today, and that a name stays
   * between them and the people they talk to. The entry is the profile
   * screen, which already knows how to edit a name. */
  nudgeBody:
    'Right now you appear as the tail of your ID. A name is friendlier — and it stays between you and the people you chat with.',
  nudgeAdd: 'Add a name',
} as const;
