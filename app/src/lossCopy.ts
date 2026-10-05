/**
 * "If this is lost or taken" — the one page in the app that says, before the
 * day, exactly what losing this device costs.
 *
 * Its own file, the `fieldModeCopy.ts` / `accountsCopy.ts` rule: a deck a
 * test can assert by IDENTITY, so a sentence cannot be re-typed slightly
 * differently in a test and quietly diverge from what ships.
 *
 * WHY THE PAGE EXISTS. The honest inventory is already true of this build
 * and is written down in four different places, none of them reachable
 * afterwards: `RegisterScreen` carries "Why there is no recovery" INSIDE the
 * create ceremony; `ProfileScreen` says "There is no backup" INSIDE a
 * delete-account confirmation; the landing screen offers "Recover my account
 * grouping" to a first-time reader who cannot know what a grouping is; and
 * the scope of that recovery only appears one screen deeper. So the harshest
 * failure mode in this product's category is a thing that happens TO people
 * rather than a thing they chose. This page is the fix, and it is free.
 *
 * THE RULES THIS DECK IS WRITTEN UNDER, each one checkable and each one
 * pinned by `__tests__/lossCopy.test.ts`:
 *
 *  - EVERY LINE NAMES A MODULE IT MUST AGREE WITH, and the test checks the
 *    agreement against that module rather than against itself:
 *      line 1 → `registration.ts` ("the keypair IS the account… deletion is
 *               the only honest exit") and `accountsCopy.recoverExplain[0]`
 *               ("Tacendum holds no copy of your messages and no copy of
 *               your keys");
 *      line 2 → `safety.ts`'s `changed` body — reinstalling or getting a new
 *               device "would make them a NEW CONTACT with a new ID", which
 *               is this sentence read from the other person's side; and
 *               `sync.ts`, where verification state is DELIBERATELY not
 *               propagated, so the trust really is pinned per person;
 *      line 3 → `accountsCopy.recoverScope`;
 *      line 4 → `linkingCopy.historyStance` (byte-pinned at
 *               `link-ceremony.test.ts`) and `sync.ts`, whose sibling sync
 *               carries NEW transcripts and nothing older.
 *
 *  - A LINE THAT CANNOT BE VERIFIED IS CUT, NEVER SOFTENED. One clause was
 *    cut on exactly that rule: the draft's line 3 named a THIRD thing an
 *    email brings back — the reserved handle the accounts program owns —
 *    and `recoverScope` says "two things only: which devices are yours,
 *    and your findability by email". A third thing this page promised and the
 *    server does not return would be discovered on the worst day of
 *    somebody's year. (The handle's own noun is deliberately not spelled
 *    anywhere in this file either: the plumbing suite runs a two-way word
 *    census over `app/src`, and a deck that spelled it would need an
 *    allowlist row it has no business owning.)
 *
 *  - NO DEVICE NOUN. `DEVICE_NOUN` is deliberately absent and the sentences
 *    are written round the noun ("made here", "every room here", "a
 *    second linked device"), so the copy works on phones and tablets alike,
 *    following the same technique as `fieldModeCopy.ts`.
 *
 *  - NO REASSURANCE THAT IS NOT TRUE. There is no "make sure you have a
 *    backup", because there is none to have; no "contact support", because
 *    support cannot help; and no adjective anywhere doing the work a fact
 *    should do.
 */
export const LOSS_COPY = {
  /** The ACCOUNT row. "This", not the device noun — and "or taken", because
   * seizure is the case the reader of this page is most likely thinking
   * about and pretending otherwise would be its own small dishonesty. */
  row: 'If this is lost or taken',
  /** The in-screen step's own title (the Licenses idiom: a step, not a
   * route, so nothing about the visible-surface matrix moves). */
  title: 'If this is lost or taken',
  lines: [
    'Your identity is a key that was made here and has never left. If it is gone, it is gone — nobody at Tacendum can bring it back, because we never had it.',
    'What goes with it: your Tacendum ID, every room here, and the trust each person has pinned to you. To reach them again you would be someone new, and they would add you again.',
    'What an email brings back, if you have linked one: which devices are yours, and being findable by that email. Never the key, never the messages, never the trust — everyone sees a fresh safety number.',
    'What helps today: a second linked device keeps its own copy of what it has seen since you linked it. It is not a backup — it starts empty and fills from there.',
  ],
  /** The ⓘ says what the disclosure is ABOUT, the house rule for every ⓘ in
   * this app. Here that is the timing, which is the whole argument for the
   * page existing at all. */
  infoLabel: 'Why read this now',
  infoLines: ['Worth reading once, now, rather than on the day.'],
} as const;
