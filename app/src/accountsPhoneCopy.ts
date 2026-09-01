import { ACCOUNTS_COPY } from './accountsCopy';
import { DEVICE_NOUN } from './deviceNoun';

/**
 * The PHONE identifier / discovery / recovery copy deck — AccountPhoneScreen's half of the accountsCopy.ts discipline: one
 * PURE module (no api, no db, no react-native beyond the noun token) so
 * device-noun.test.ts can load it per idiom. Every sentence that names the
 * device interpolates `DEVICE_NOUN`; hardcoding a device noun here fails
 * that suite on the idioms it lies to. Every phone surface that renders any
 * of this sits behind the build-pinned `PHONE_UI_ENABLED` (phoneUi.ts —
 * build-pinned): the deck ships in the binary DARK until its own release train.
 *
 * Consent-grade means the costs are IN the sentence, not implied:
 *  - the toggle carries the honest-weakness sentence at FULL
 *    sharpness for phone (a ~10^10 structured keyspace: the claim rows are
 *    enumeration-resistant only through the secret PLUS the caller gates
 *    and budgets — leak-resistance and scraper-resistance, never
 *    server-blindness, and the sentence does not soften; the mechanism is
 *    IN the sentence) and the
 *    per-class fact (email consent never implies phone consent, nor the
 *    reverse);
 *  - entry is country-code-explicit: the + is part of the
 *    number, a number without it is refused rather than guessed;
 *  - the search and recovery answers keep the uniform-refusal honesty
 *    word for word — the server refuses to be an oracle, so this copy
 *    refuses to pretend it knows.
 */
export const ACCOUNTS_PHONE_COPY = {
  /** The deck slot for the third one-line Settings row (the honest-ledger
   * shape). STAGED: the row itself is DEFERRED — no Settings surface mounts
   * it yet, so this label has no consumer until the phone surfaces ship. No idiom noun on purpose: the row names the surface. */
  settingsRow: 'Phone number & discovery',
  numberTitle: 'Phone number',
  numberIntro: `A phone number is optional. It never becomes your login — this ${DEVICE_NOUN} still signs in with its key — and people you message never see it. It does two things only: it can win your account grouping back if every device is lost, and, only if you turn it on below, it can let someone who already knows this number find you.`,
  numberPlaceholder: '+1 555 555 0100',
  /** Said before the field: the + is part of the number. */
  numberFormatNote:
    'Start with the country code — the + is part of the number. Tacendum never guesses a country: a number without it is refused, not repaired.',
  /** The LOCAL refusal: this device's own knowledge of the shape,
   * honestly distinguishable from the server's collapsed answers. */
  numberInvalid:
    'That is not a complete phone number. Start with the country code, like +15555550100 — a number without its + is refused rather than guessed.',
  numberRequest: 'Text me a code',
  numberRequestAgain: 'Send another code',
  /** THE SMS CONSENT SENTENCE (the US toll-free registration's DIGITAL_FORM
   * opt-in) — a SEPARATE, UNCHECKED checkbox carries it on the attach form:
   * a typed number alone is not consent, so the send affordance stays
   * disabled until this box is checked. ONE deck string on purpose: the
   * carrier registration's description quotes it byte-for-byte, so it must
   * never be split, reflowed, or interpolated. The HELP/STOP auto-responses
   * it promises are configured and live on the number. No device noun in
   * this sentence by construction. */
  smsConsentLabel:
    'By checking, you consent to receive one-time verification codes from Mirana Technologies Inc. Message frequency: one code per request. Message and data rates may apply. Reply HELP for help or STOP to opt out.',
  /** The policy links BESIDE the checkbox (the toll-free review criteria
   * list missing T&C/privacy links adjacent to the opt-in as a denial
   * reason): independently tappable references NEXT TO the consent row,
   * never bundled into the checkbox's own press target — tapping a policy
   * must never toggle consent. Same labels as RegisterScreen's policy
   * foot; the URLs are the version.ts compile-time constants. */
  smsConsentTermsLabel: 'Terms',
  smsConsentPrivacyLabel: 'Privacy policy',
  /** The uniform answer, said as what it is: the server answers
   * the same whether or not anything was sent — and says the maybe out
   * loud, exactly the email deck's emailCodeSent shape (the ⓘ beside the
   * button carries the phone class's own numbers). */
  numberCodeSent: (number: string) =>
    `If ${number} can receive text messages from Tacendum, a 6-digit code is on its way. It works for 5 minutes. This answer looks the same when nothing was sent — codes are rationed, so asking again does not always send again.`,
  /** TEACHING, behind the ⓘ (house style): the phone class's budget
   * truth — the emailCodeBudget shape at this class's own numbers (3 per
   * UTC day per number, one per minute: the server's phoneSendRecipient +
   * phoneResend budgets, tighter than email's 5 because each send costs
   * real money; the day boundary is midnight UTC, said out loud exactly
   * like the email twin). Never in the refusal banner: numberRefused stays
   * collapsed on purpose. No device noun in these sentences on purpose. */
  numberCodeBudgetLabel: 'Why a code may not arrive',
  numberCodeBudget: [
    'Tapping the button always gets the same answer, whether or not a text actually went out. The server deliberately never confirms a send — so this screen cannot either.',
    'Codes are rationed: a phone number can be sent at most 3 codes in a day, and never more than one a minute. The day is counted in universal time (UTC) — the allowance resets at midnight UTC, which is probably not your midnight. Asking past either limit quietly sends nothing, and the answer here still looks the same, by design.',
    'If you have asked several times and nothing arrives, the day’s allowance for this number may already be spent. Try again after midnight UTC, or use another number that can receive texts.',
  ],
  codePlaceholder: '6-digit code',
  numberVerify: 'Verify',
  numberRefused:
    'That did not work. The code may be wrong or expired, or this number may already be linked elsewhere — the server deliberately does not say which. Request a fresh code to try again.',
  numberVerified: (number: string) => `${number} is linked to your account.`,
  numberUnlink: 'Remove this phone number',
  /** The unlink confirm's keep verb, IN the deck: a
   * user-visible literal outside the chokepoint escapes the drift net the
   * deck exists to hold. */
  numberUnlinkKeep: 'Keep it',
  /** Per-class unlink honesty: the
   * other class survives by construction. */
  numberUnlinkConfirm: (number: string) =>
    `Remove ${number}? It can no longer recover your account grouping, and nobody can find you by it. Your devices and chats are untouched — and so is your email, if you linked one.`,
  numberUnlinkRefused: 'That did not work. Try again.',

  /* ── discoverability (the design consent toggle, per CLASS) ──────── */
  discoverableTitle: 'Findable by phone number',
  discoverableLabel: 'People who have my number can find me',
  discoverableExplainLabel: 'What turning this on discloses',
  discoverableExplain: [
    'On means: anyone who types this exact number into Tacendum can find your account — they learn how many devices it has and what kinds, and can start a chat with you. Nobody is told your number by Tacendum; only someone who already knows it can use it.',
    'Off is the default, and off means nobody can look you up by this number.',
    // Consent is PER CLASS — structural since the per-class
    // migration (each class's consent lives on its own row).
    'This switch covers your phone number only. Turning it on does not make your email findable, and the other way round — each has its own switch.',
    // At FULL sharpness for phone — leak-resistance, never
    // server-blindness, and the sentence does not soften. The MECHANISM is
    // in the sentence: what resists guessing is the
    // secret PLUS the caller gates and budgets — never the scrambling
    // alone, and never the server's own blindness.
    'What the server stores is a scrambled form of the number, keyed by a secret the server holds. Be honest about what that buys: there are only about ten billion possible phone numbers, so the stored list resists guessing only through that secret plus the strict limits on who may search and how often. That is leak-resistance and scraper-resistance, never server-blindness — the operator of the server, or someone who compels them, could still test every number against it.',
    'After an account recovery, findability pauses for 7 days even when this is on — so a stolen number cannot instantly redirect the people who look you up.',
    'This switch is your side of the record: the server deliberately answers every consent change identically, so what you see here is what you set — never a receipt.',
  ],
  /** The restored-placeholder honesty (per class):
   * recovery restored the server-side setting, which cannot be read back. */
  discoverableRestored:
    'Your findability came back with your account: whatever it was before recovery is still in force on the server, after the 7-day pause. It cannot be read back here, so the switch below starts unset. Choose once — your choice replaces the old setting.',
  discoverableFailed:
    'That change did not save here. The server may or may not have recorded it — set the switch again so both agree.',

  /* ── find by number (the typed class the find flow gains) ───── */
  /** The class entry's labels: the class is SHOWN, never silently inferred. */
  classLabelEmail: 'Email',
  classLabelNumber: 'Phone number',
  discoverIntroNumber:
    'Type the phone number of someone who chose to be found — with its country code. Only people who verified a number and turned findability on can appear here.',
  /** The four-way indistinguishability, extended to the phone
   * classes — same designed collapse, same closing sentence. */
  discoverNoMatchNumber:
    'No match. That covers several cases on purpose: this number may not be on Tacendum, its owner may not have turned findability on, they may be inside a recovery pause — or your searches for today may be used up. Tacendum cannot tell you which, by design.',
  /** The class-blind caller gate, stated honestly: ANY
   * verified identifier passes, so the hint names both. */
  discoverNeedsOwnIdentifier:
    'Searching needs a verified email or phone number on your own account — the same round-trip you would ask of others.',
  /** The class-aware header + accessibility label:
   * with the number class selected the surface says what it is — the email
   * title must not sit over a phone flow. */
  discoverTitleNumber: 'Find by phone number',
  /** The result card's trust sentence for the number class:
   * the same TOFU fact, the class named honestly. */
  discoverTofuNumber:
    'The first message sets up keys exactly like any new chat — being found by phone number changes who you can reach, never how much they are trusted.',
  /** The why-every-miss explainer for the number class: the
   * email lines discussed typing and verifying an email; these name the
   * number, and the caller-gate line says the CLASS-BLIND gate honestly
   * (any verified identifier passes). */
  discoverExplainNumber: [
    'If a miss looked different from “registered but not findable”, typing a number would reveal whether its owner uses Tacendum — without their consent. So every refusal is identical, including the one your own daily search budget causes.',
    'Searching needs a verified email or phone number on your own account, and an account at least three days old. That makes bulk scraping expensive without changing what you see here.',
  ],
  /** The EMAIL class's explainer with the phone class live: the
   * landed second line said "needs a
   * verified email" — with the pin on, the gate is CLASS-BLIND, so the
   * caller-gate line names both classes while the first line keeps its
   * landed bytes by reference. Pin false: the landed lines render
   * untouched. */
  discoverExplainEmailBoth: [
    ACCOUNTS_COPY.discoverExplain[0],
    'Searching needs a verified email or phone number on your own account, and an account at least three days old. That makes bulk scraping expensive without changing what you see here.',
  ],

  /* ── recovery (the same narrow scope, both classes) ────── */
  /** THE SCOPE SENTENCE with the phone door open: the same two-things-only
   * scope, the same honesty, the identifier clause widened to the class
   * pair. Renders ONLY under PHONE_UI_ENABLED; the landed email-only
   * sentence keeps its bytes while the pin is false. */
  recoverScopeBoth:
    'Recovery restores two things only: your account grouping, and your findability by the email or phone number linked to it. Your messages are not here — they lived only on your old devices. Your old keys are not here — they were never stored anywhere else. Your contacts will see a new safety number and be asked to review it, exactly as if you were a new device — and until each of them accepts that change, messages between you and them wait. That warning is real and correct.',
  recoverNumberLabel: 'The phone number linked to your account',
  recoverCodeSentNumber: (number: string) =>
    `If ${number} is linked to an account, a code is on its way. The answer here looks the same either way — only the device holding that number knows.`,
  /** The request CTA for the number class: the email
   * verb ("Email me a recovery code") was rendering over the phone flow. */
  recoverRequestNumber: 'Text me a recovery code',
  /** The pre-registration handoff with the phone door open:
   * the landed email-only sentence keeps its bytes while the pin is
   * false. */
  recoverNeedsIdentityBoth: `First, this ${DEVICE_NOUN} creates its own fresh identity — that part is the same for everyone and asks for no email or phone number. Then the email or phone number linked to your old account can attach it to your old account grouping.`,
  /** The why-recovery-is-narrow lines with the phone door open:
   * the first three commitments are the landed sentences BY REFERENCE (one
   * source, no drift) — only the findability-pause line widens to the class
   * pair, because the pause really does cover every identifier class the
   * account holds. */
  recoverExplainBoth: [
    ACCOUNTS_COPY.recoverExplain[0],
    ACCOUNTS_COPY.recoverExplain[1],
    ACCOUNTS_COPY.recoverExplain[2],
    'After recovery, being findable by the email or phone number linked to your account pauses for 7 days.',
  ],

  /* ── the EMAIL surface with the phone class live — rendered ONLY under PHONE_UI_ENABLED, the recoverScopeBoth
   *    pattern: the landed email sentences keep their exact bytes while
   *    the pin is false, and these variants replace them only in a binary
   *    where a second identifier class actually exists ─────────────────── */
  /** With a second class in the world, the landed "by this
   * email or anything else" would overpromise — off is per CLASS,
   * and the mirror of the phone toggle's per-class sentence is said on the
   * email toggle too. */
  emailDiscoverableExplainBoth: [
    ACCOUNTS_COPY.discoverableExplain[0],
    'Off is the default, and off means nobody can look you up by this email.',
    'This switch covers your email only. Turning it on does not make your phone number findable, and the other way round — each has its own switch.',
    ACCOUNTS_COPY.discoverableExplain[2],
    ACCOUNTS_COPY.discoverableExplain[3],
    ACCOUNTS_COPY.discoverableExplain[4],
  ],
  /** The downgrade names EVERY identifier it removes — the
   * dissolve takes the phone claim server-side and the local phone row
   * with it, so hiding the phone class from this confirmation would
   * destroy state the sentence never disclosed. */
  downgradeIntroBoth: `Removes any email or phone number linked to your account, with your findability by either, and un-groups your devices. Every device keeps its own chats — nothing leaves this ${DEVICE_NOUN} — and each continues as its own separate account, exactly what it always was underneath.`,
  downgradeConfirmBoth:
    'Go back to anonymous? Any linked email or phone number and your findability are deleted, your devices stop being grouped, and the people you talk to will see your devices as unrelated contacts from now on.',
} as const;
