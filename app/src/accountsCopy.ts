import { DEVICE_NOUN } from './deviceNoun';

/**
 * The identifier / discovery / recovery copy deck — one
 * PURE module for the four accounts surfaces (email attach, discoverability,
 * find-by-email, recovery), exactly the linkingCopy.ts discipline: no api,
 * no db, no react-native beyond the noun token, so device-noun.test.ts can
 * load it per idiom. Every sentence that names the device interpolates
 * `DEVICE_NOUN`; hardcoding a device noun here fails that suite on the
 * idioms it lies to.
 *
 * Consent-grade means the costs are IN the sentence, not implied:
 *  - the toggle states what ON discloses (the stated disclosure: anyone who
 *    already knows the email learns the account's devices) and the honest
 *    weakness in plain words (leak-resistance, not server-blindness);
 *  - the search states the designed indistinguishability (miss,
 *    not-discoverable, spent budget, and the recovery cool-down all answer
 *    identically — the server refuses to be an oracle, so this screen
 *    refuses to pretend it knows);
 *  - recovery states its narrow scope loudly (grouping + findability ONLY;
 *    never messages, never keys; peers see a full safety reset).
 */
export const ACCOUNTS_COPY = {
  /* ── email attach (the Settings surface) ─────────────────────── */
  /** The ONE Settings row that opens this surface. In the deck
   * per the linkingCopy discipline — the settings label is accounts copy,
   * never a hardcoded noun in SettingsScreen. No idiom noun on purpose: the
   * row names the surface, not this device. */
  settingsRow: 'Email & discovery',
  emailTitle: 'Email',
  emailIntro: `An email is optional. It never becomes your login — this ${DEVICE_NOUN} still signs in with its key — and people you message never see it. It does two things only: it can win your account grouping back if every device is lost, and, only if you turn it on below, it can let someone who already knows this email find you.`,
  emailPlaceholder: 'you@example.com',
  emailRequest: 'Email me a code',
  emailRequestAgain: 'Send another code',
  /** The uniform answer, said as what it is: the server answers the same
   * whether or not anything was sent, so the sentence promises
   * only what this device knows — and says the maybe out loud: codes are
   * budgeted, so a tap past the budget produces exactly this answer with
   * nothing sent (the ⓘ beside the button carries the numbers). */
  emailCodeSent: (address: string) =>
    `If ${address} can receive mail from Tacendum, a 6-digit code is on its way. It works for 5 minutes. This answer looks the same when nothing was sent — codes are rationed, so asking again does not always send again.`,
  /** TEACHING, behind the ⓘ (house style): the budget truth the uniform
   * answer deliberately hides (5 per UTC day per address, one per minute —
   * the server's identifierSendRecipient + identifierResend budgets; the
   * review caught "tomorrow" implying a local-calendar reset, so the
   * boundary is said as what it is: midnight UTC). The
   * numbers live HERE and never in the refusal banner: the server
   * collapses every refusal on purpose (emailRefused says so), and a
   * banner that guessed "budget" would pretend to knowledge this device
   * does not have. No device noun in these sentences on purpose. */
  emailCodeBudgetLabel: 'Why a code may not arrive',
  emailCodeBudget: [
    'Tapping the button always gets the same answer, whether or not an email actually went out. The server deliberately never confirms a send — so this screen cannot either.',
    'Codes are rationed: an address can be sent at most 5 codes in a day, and never more than one a minute. The day is counted in universal time (UTC) — the allowance resets at midnight UTC, which is probably not your midnight. Asking past either limit quietly sends nothing, and the answer here still looks the same, by design.',
    'If you have asked several times and nothing arrives, the day’s allowance for this address may already be spent. Check the spam folder, try again after midnight UTC, or use another address.',
  ],
  codePlaceholder: '6-digit code',
  emailVerify: 'Verify',
  /** The collapsed refusal, rendered honestly (the server deliberately does
   * not say which condition refused). */
  emailRefused:
    'That did not work. The code may be wrong or expired, or this address may already be linked elsewhere — the server deliberately does not say which. Request a fresh code to try again.',
  /** A TRANSPORT failure (offline, DNS, a dead socket — accounts.ts's
   * 'failed', never its 'refused'), said as what it is: the refusal
   * sentence above would lie about a code that was never checked, and in a
   * duress session every call fails this way (rule 15 — the offline cover
   * story). The sibling decks' sentence (phone and handle), byte-for-byte —
   * the handle class's word census keeps its name out of this deck, so it
   * is named by role here. */
  failed: 'Could not reach Tacendum. Check your connection and try again.',
  emailVerified: (address: string) => `${address} is linked to your account.`,
  emailUnlink: 'Remove this email',
  emailUnlinkConfirm: (address: string) =>
    `Remove ${address}? It can no longer recover your account grouping, and nobody can find you by it. Your devices and chats are untouched.`,
  emailUnlinkRefused: 'That did not work. Try again.',

  /* ── discoverability (the design consent toggle, default OFF) ────────────── */
  discoverableTitle: 'Findable by email',
  discoverableLabel: 'People who have my email can find me',
  /** What ON means, stated before the switch is thrown — the stated
   * disclosure plus the honest weakness, in plain words. */
  discoverableExplainLabel: 'What turning this on discloses',
  discoverableExplain: [
    'On means: anyone who types this exact email into Tacendum can find your account — they learn how many devices it has and what kinds, and can start a chat with you. Nobody is told your email by Tacendum; only someone who already knows it can use it.',
    'Off is the default, and off means nobody can look you up — by this email or anything else.',
    'What the server stores is a scrambled form of the address, keyed by a secret. That protects the list if it leaks, and stops bulk scraping — but the operator of the server, or someone who compels them, could still test addresses against it. This buys leak-resistance, not blindness.',
    'After an account recovery, findability pauses for 7 days even when this is on — so a stolen email cannot instantly redirect the people who look you up.',
    'This switch is your side of the record: the server deliberately answers every consent change identically, so what you see here is what you set — never a receipt.',
  ],
  /** Shown while the row is the RESTORED placeholder: recovery restored the server-side setting, which cannot be
   * read back — the switch below is unset until the owner chooses. */
  discoverableRestored:
    'Your findability came back with your account: whatever it was before recovery is still in force on the server, after the 7-day pause. It cannot be read back here, so the switch below starts unset. Choose once — your choice replaces the old setting.',
  /** The write's honest weight: the 204 is uniform by design, so the row
   * records this device's own decision, exactly like consent edges — and a
   * failed local save must not pretend to know what the server holds. */
  discoverableFailed:
    'That change did not save here. The server may or may not have recorded it — set the switch again so both agree.',

  /* ── find by email (the start-chat surface) ──────────────────── */
  discoverTitle: 'Find by email',
  discoverIntro:
    'Type the email of someone who chose to be found. Only people who verified an email and turned findability on can appear here.',
  discoverSearch: 'Search',
  /** The designed indistinguishability, said instead of hidden: the server
   * answers the same for every case the caller has no right to resolve. */
  discoverNoMatch:
    'No match. That covers several cases on purpose: this email may not be on Tacendum, its owner may not have turned findability on, they may be inside a recovery pause — or your searches for today may be used up. Tacendum cannot tell you which, by design.',
  discoverExplainLabel: 'Why every miss looks the same',
  discoverExplain: [
    'If a miss looked different from “registered but not findable”, typing an email would reveal whether its owner uses Tacendum — without their consent. So every refusal is identical, including the one your own daily search budget causes.',
    'Searching needs a verified email on your own account, and an account at least three days old. That makes bulk scraping expensive without changing what you see here.',
  ],
  discoverError: 'The search could not reach the server. Check your connection and try again.',
  /** The result card — labeled with the email the finder TYPED, never an
   * account id (no ULID anywhere in this flow). */
  discoverResult: (typed: string) => `Start a chat with ${typed}?`,
  discoverResultDevices: (count: number) =>
    count === 1 ? 'This account answers on one device.' : `This account answers on ${count} devices.`,
  discoverStart: 'Start the chat',
  discoverTofu:
    'The first message sets up keys exactly like any new chat — being found by email changes who you can reach, never how much they are trusted.',
  /** Shown when this account holds no verified email of its own. */
  discoverNeedsOwnEmail:
    'Searching needs a verified email on your own account — the same round-trip you would ask of others.',

  /* ── downgrade to anonymous ───────────────────────────────── */
  downgradeTitle: 'Go back to anonymous',
  downgradeIntro: `Removes your email and your findability, and un-groups your devices. Every device keeps its own chats — nothing leaves this ${DEVICE_NOUN} — and each continues as its own separate account, exactly what it always was underneath.`,
  downgradeConfirm:
    'Go back to anonymous? Your email and findability are deleted, your devices stop being grouped, and the people you talk to will see your devices as unrelated contacts from now on.',
  downgradeAction: 'Downgrade',
  downgradeDone: 'Done. This account is anonymous again.',
  downgradeFailed:
    'The downgrade did not finish. Whatever was already removed stays removed — try again to finish the rest.',

  /* ── recovery ────────────────── */
  recoverTitle: 'Recover my account grouping',
  /** THE SCOPE SENTENCE — stated before anything is asked. */
  recoverScope:
    'Recovery restores two things only: your account grouping, and your findability by email. Your messages are not here — they lived only on your old devices. Your old keys are not here — they were never stored anywhere else. Your contacts will see a new safety number and be asked to review it, exactly as if you were a new device — and until each of them accepts that change, messages between you and them wait. That warning is real and correct.',
  recoverExplainLabel: 'Why recovery is this narrow',
  recoverExplain: [
    'Tacendum holds no copy of your messages and no copy of your keys — so there is nothing more it could give back, to you or to anyone pretending to be you.',
    'Recovery waits 72 hours, and every device still linked to the account is told and can cancel it. A cancel always wins.',
    'If a device of yours still holds the slot you are recovering — usually the lost one — completing recovery permanently signs it out of the account. It cannot come back.',
    'After recovery, being findable by email pauses for 7 days.',
  ],
  /** Pre-registration: recovery sits BESIDE registration, never inside it. */
  recoverNeedsIdentity: `First, this ${DEVICE_NOUN} creates its own fresh identity — that part is the same for everyone and asks for no email. Then your email can attach it to your old account grouping.`,
  recoverCreateIdentity: 'Create this device’s identity',
  recoverEmailLabel: 'The email linked to your account',
  recoverRequest: 'Email me a recovery code',
  recoverCodeSent: (address: string) =>
    `If ${address} is linked to an account, a code is on its way. The answer here looks the same either way — only the inbox knows.`,
  recoverVerify: 'Start recovery',
  /**
   * The code field without a request: a code already in the inbox — from
   * a tap on another device, or one this screen forgot. */
  recoverHaveCode: 'I already have a code',
  /** The resend cool-down, counted down ON the button: a tap inside the
   * server's minute sends nothing and answers the same, so the button
   * says how long the wait is instead of inviting the tap. One sentence
   * for all three code surfaces (email attach, recovery, and the phone
   * deck by reference). */
  requestAgainIn: (clock: string) => `Send another code in ${clock}`,
  recoverRefused:
    'That did not work. The code may be wrong or expired, or this address may not be linked to an account — the server deliberately does not say which.',
  recoverPending: (completes: string) =>
    `Recovery is waiting until ${completes}. Any device still linked to the account has been told and can cancel it — a cancel wins, at any moment inside the wait.`,
  /**
   * The wait, relatively: a date three days out reads as a fact; "in 2 days
   * 3 hours" reads as a wait. Beside the date, never instead of it. */
  recoverPendingIn: (wait: string) => `Completes in ${wait}.`,
  /** What happens if the person leaves: App.tsx re-enters this surface at
   * every launch while the durable row exists (the pending-recovery
   * routing) — said plainly, and no more than that. */
  recoverPendingReturn:
    'You can leave this screen. Tacendum brings you back here the next time it opens, until the recovery is completed or set aside.',
  /** "2 days 3 hours" / "3 hours" / "12 minutes" / "less than a minute":
   * the two largest units that are not zero, floored — a wait is never
   * rounded up into a promise. */
  waitLabel: (remainingMs: number): string => {
    const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
    const minutes = Math.floor(Math.max(0, remainingMs) / 60_000);
    const days = Math.floor(minutes / 1_440);
    const hours = Math.floor((minutes % 1_440) / 60);
    if (days > 0) return hours > 0 ? `${unit(days, 'day')} ${unit(hours, 'hour')}` : unit(days, 'day');
    if (hours > 0) return unit(hours, 'hour');
    if (minutes > 0) return unit(minutes, 'minute');
    return 'less than a minute';
  },
  recoverComplete: 'Complete recovery',
  recoverNotYet: 'The waiting period has not passed yet.',
  recoverCompleteRefused:
    'Completion was refused. One of your devices may have cancelled the recovery, or it may not be time yet — the server deliberately does not say which.',
  recoverDone:
    'Your account grouping is restored. Your messages are not here — they stayed on your old devices. The people you talk to will see a new safety number for you and be asked to review it — until they accept it, messages between you wait.',
  /** LOCAL-ONLY, and the label says so: the
   * recovering device is not a member, so the member-authorized cancel
   * route refuses it by design — this verb can only discard this device's
   * own record of the attempt. */
  recoverAbandon: 'Set this recovery aside',
  recoverAbandonNote: `This clears the attempt from this ${DEVICE_NOUN} only. The request itself stays open on the server until it expires — and any device still linked to the account keeps seeing it and can cancel it.`,

  /* ── recovery notices (the surviving member's surface) ───────── */
  // CLASS-NEUTRAL: the notice carries the device class only (linking.ts) —
  // never which identifier class proved the code — so neither sentence may
  // claim "your account's email". The phone class is dark for now, and
  // a pin-OFF binary must not name it either; "an identifier linked to
  // your account" is true of every class.
  noticeRequested: (slot: string, completes: string) =>
    `Someone used an identifier linked to your account to claim this grouping as its ${slot}. If that is not you, cancel before ${completes} — your cancel wins.`,
  noticeCancelAction: 'Cancel the recovery',
  noticeCancelled: 'The recovery was cancelled. Nothing changed.',
  noticeCancelFailed: 'The cancel did not go through. Try again — it wins at any moment inside the wait.',
  noticeCompleted: (slot: string) =>
    `A recovery completed: a new device joined this account as its ${slot}. If that was not you, revoke it here and remove the identifier it used from your account.`,
} as const;
