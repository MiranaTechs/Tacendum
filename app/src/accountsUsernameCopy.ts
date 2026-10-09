/**
 * The USERNAME claim / consent / find / revocation copy deck — the accountsPhoneCopy.ts discipline: one PURE module (no
 * api, no db, no react-native) so the copy suites can load it as data.
 * Every username surface that renders any of this sits behind the
 * build-pinned `USERNAME_UI_ENABLED` (usernameUi.ts): the deck ships
 * in the binary DARK until its own release train.
 *
 * THE HONESTY POSTURE OF THIS CLASS, rewritten for a low-entropy public
 * namespace: the risk is located at the online surfaces, not the
 * scrambling; no false email/phone contrast; no absolutes the operator
 * model contradicts; and NEVER a claim that the server is blind to the name
 * anywhere near this class — claim plaintext transits the server by
 * necessity, and what the design buys is leak-resistance and scraper-
 * resistance, nothing more. "Treat your username as public information" is
 * the sentence every other sentence serves.
 *
 * The display posture is copy-level too: the handle is a FINDING
 * label, never a name layer — no `@` sigil anywhere in this deck, and the
 * naming deck's display name is a different thing (NamingScreen pins that
 * the word "username" never appears there).
 *
 * No device noun in this deck by construction: nothing here names the
 * device, so the per-idiom census (android.copy.divergences) is untouched.
 */
import { PHONE_UI_ENABLED } from './phoneUi';

export const ACCOUNTS_USERNAME_COPY = {
  /** The Settings row (the phone row's shape; mounted only under the pin). */
  settingsRow: 'Username & discovery',
  title: 'Username',
  /** The lead, before the field: what a username is FOR — one purpose. */
  intro:
    'A username is optional. People can use it to find you when you allow it.',
  /** The Settings > Account lead (V1, 2026-10-08): a FACT true in every
   * state — verified or not, this device or a linked sibling whose local
   * rows are empty. It used to be an instruction ("Verify an email address
   * to…"), which read as an unfinished setup step on every account. */
  verificationSummary: PHONE_UI_ENABLED
    ? 'Usernames and username search need a verified email or phone number on the account. Rooms and calls by Tacendum ID or QR code need none.'
    : 'Usernames and username search need a verified email on the account. Rooms and calls by Tacendum ID or QR code need none.',
  withoutVerification:
    'No verification needed to chat or call using a Tacendum ID or QR code.',
  /** The ⓘ label over the honesty copy: what the disclosure is ABOUT. */
  infoLabel: 'What a username discloses',
  /** THE HONESTY COPY (verbatim — behind the ⓘ). */
  infoLines: [
    'Your username is not a login and is not shown as your name in rooms. It does not verify someone’s identity; compare safety numbers for that.',
    'A username is public by nature — an email address or phone number is private information; a username is not. We store only a scrambled form of your username, never the name itself, so a leak of our records alone does not reveal it.',
    'Usernames are short and guessable, so the real protections are limits, not scrambling: every search and every claim attempt is strictly limited and monitored, no one using the app can find your account by name unless you allow it, and you can change or remove your name at any time.',
    'Treat your username as public information.',
  ],
  fieldPlaceholder: 'alice_smith',
  /** The shape, said before the field: refused, never repaired. */
  formatNote:
    '3 to 32 characters: lowercase letters, digits and underscores, starting with a letter. Capitals are lowered; anything else is refused rather than repaired.',
  /** The LOCAL refusals — this device's own knowledge of the shape and the
   * public denylist, honestly distinguishable from the server's answers. */
  invalid:
    'That is not a valid username. Use 3 to 32 lowercase letters, digits or underscores, starting with a letter.',
  reserved: 'That name is reserved — try another.',
  /** The possession-proof precondition for claim and username lookup,
   * surfaced from the server's caller-owned group answer. */
  /**
   * The door beside the sentence above: the step it names, one tap away.
   * Opens the email surface — the class every binary can link. */
  needsIdentifierAction: 'Link an email',
  needsIdentifier: PHONE_UI_ENABLED
    ? 'Verify an email address or phone number first to set or search usernames. This helps limit automated accounts and bulk searches.'
    : 'Verify an email address first to set or search usernames. This helps limit automated accounts and bulk searches.',
  eligibilityChecking: 'Checking whether this account can use usernames…',
  /** A TRANSPORT failure of the state read (no network, the deadline): the
   * connection sentence, byte-identical to build 33's. */
  eligibilityUnavailable: 'Could not check username access. Check your connection and try again.',
  /** The state read REFUSED (U3, 2026-10-08): the frozen 403 — this
   * device's identifier-route budget or a dark flag, never a connection
   * problem — so the sentence blames nothing and asks for a minute. */
  eligibilityRefused:
    'Tacendum could not check username access right now. Try again in a minute.',
  eligibilityRetry: 'Try again',
  /** This device's own pacing of its identifier-route calls (U3): the
   * server allows ten a minute per device, so the eleventh is said BEFORE
   * the tap instead of coming back as the reasonless refusal. */
  paced: (seconds: number) => `Try again in ${seconds} s.`,
  /** The claim form after an unlink THIS device performed (an unlink
   * stamps the same 30-day cool-down a rename does, and only the exact
   * unlinked name is reclaimable inside it). The server's refusal of a
   * different name is the reasonless 403 by design, so this device — which
   * pressed the button — is the only place the person can learn why.
   * An EMPTY name is the unlink this device performed without a readable
   * local row (the name lived on a sibling device, or the row was wiped):
   * the server never echoes a name, so the sentence keeps the rule and the
   * reclaim fact but names nothing. */
  cooldownAfterUnlink: (name: string) =>
    name === ''
      ? 'You removed your username within the last 30 days, so a different name has to wait — a username can change once every 30 days. Only the exact name you removed can be taken back right away.'
      : `You removed ${name} within the last 30 days, so a different name has to wait — a username can change once every 30 days. ${name} itself can be taken back right away.`,
  /** THE DATED COOL-DOWN (U2, 2026-10-08). The window is a group fact the
   * wire never explains (UN-C4): the device remembers every verb that
   * stamps it — a rename and an unlink alike — and reads its end from the
   * caller-owned state route where it answers, so a linked sibling and a
   * reinstalled phone say the date too. `date` is the window's end, in
   * plain words, in the device's locale and time zone. */
  /** Beside "Change my username" while a name is held (here or on another
   * device), and the answer to a refusal inside a known window. */
  cooldownUntil: (date: string) => `You can change your username again on ${date}.`,
  /** The claim form inside a known window — under the unlink warning on
   * the device that pressed Remove, and the answer to a refusal there. */
  cooldownUntilClaim: (date: string) => `You can choose a different name from ${date}.`,
  /** The claim form inside a window this device did not start (the name
   * was changed or removed on another device): the rule, the date, and the
   * one exception — said without a name, because none travels (§4.9). */
  cooldownElsewhere: (date: string) =>
    `A username was changed or removed within the last 30 days, so a different name has to wait: you can choose one from ${date}. Only the exact name that was removed can be taken back right away.`,
  /** The phantom after a sibling's REMOVE, merged with the window it
   * started (the proof pass, 2026-10-08: two stacked notices used to hedge
   * the same fact — "changed or removed" twice). One notice, the fact it
   * knows, the date, the one exception. */
  phantomRemovedWindow: (date: string) =>
    `Your username was removed from another device, so a different name has to wait: you can choose one from ${date}. Only the exact name that was removed can be taken back right away.`,
  /** Inside a known window the holder's Change is withheld (the server
   * refuses every rename there, the old dead form — the proof pass) and the
   * one way back is said instead: Remove, then claim the old name — the
   * take-back is free inside the window; the wait for a DIFFERENT name
   * starts over from the removal. */
  takeBackNow:
    'To go back to your previous name now, remove this one and claim it again — your previous name can be taken back right away, and the 30-day wait for a different name starts over from the removal.',
  /** The held state's one line on HOW others reach this name (build 24 —
   * testers could not find find-by-username). Since build 33 the name is
   * typed straight into Open a room's one field: there is no door to name. */
  howFound: 'Others can find you by typing this name when they open a room.',
  /* ── Open a room's smart field, under the pin (build 33) ── */
  /** The no-directory sentence with the username class live (line 1 of the
   * screen's ⓘ). A pin-OFF binary renders that screen's own email-only
   * sentence byte-for-byte. */
  startChatNoDirectory:
    'Tacendum has no public directory. A room starts with a Tacendum ID one person hands the other — or with the email or username of someone who chose to be found.',
  /** The field's placeholder and accessible name: the three things it reads. */
  startChatFieldPlaceholder: 'Paste their ID, username or email',
  startChatFieldLabel: 'Their Tacendum ID, username or email',
  /** "That’s you" for your own claimed name, and the go key's answer. */
  startChatSelfStatus: 'Your username',
  startChatSelfError: 'That’s your own username. Ask them for theirs.',
  /** Text that is none of the three, after the pause or a blur. */
  startChatUnknown: 'Not an ID, username or email yet',
  startChatErrorUnknown: 'That isn’t an ID, a username or an email. Check what they sent you.',
  /** The shape, said under a malformed name of three characters or more
   * (refused on the device, so it never spends a search). */
  startChatHandleRule:
    'A username is 3 to 32 letters, digits or underscores, starting with a letter.',
  startChatFindA11y: 'Find this username',
  /** Line 4 of the screen's ⓘ: who can be found, and the daily limit. */
  startChatFindScope:
    'A username or email finds only someone who verified an email — or claimed a username — and chose to be found. Searches are limited each day.',
  /** The found card's ⓘ "Is this really them?" for this class. The second
   * line is the email card's, word for word (one condition, one sentence). */
  startChatFoundInfo: [
    'Anyone can claim a username, so finding one doesn’t prove who is behind it.',
    'To be sure it’s them, compare safety numbers in person or on a call. Being found changes who you can reach, never how much they are trusted.',
  ],
  /** Line 1 of the miss ⓘ for this class; `findExplain` follows it. Since
   * 2026-10-08 it also says what the server keys on the ACCOUNT GROUP and
   * this device cannot tell from its own rows (D1: a self-search from a
   * linked sibling misses by design; D3: the day's searches are one budget
   * for all linked devices and reset on the UTC day). */
  startChatMissInfoLead:
    'A miss can mean the username isn’t on Tacendum or its owner hasn’t chosen to be found — or your searches for today are used up (they are shared by your linked devices and reset at midnight UTC). Searching for your own email or username, from any of your devices, always shows no match.',
  /** The VISIBLE miss line when the account holds a username this device
   * cannot match the typed text against (a linked sibling: names never
   * travel — the proof pass, 2026-10-08): the self case joins the line
   * itself, not only the ⓘ behind it. Otherwise the screen's own line. */
  startChatMissLineMaybeSelf:
    'No match — or you’ve used today’s searches, or it’s your own: your own username always shows no match. Tacendum cannot tell you which, by design. Searches are shared by your linked devices and reset at midnight UTC.',
  /** The needs-verification door on Open a room. The reason that follows
   * it in `needsIdentifier` sits behind the ⓘ beside it instead. */
  startChatNeedsIdentifier: 'Verify an email first to search usernames.',
  startChatVerifyWhyLabel: 'Why verify first',
  /** Byte-equal to the second sentence of `needsIdentifier`. */
  startChatVerifyWhy: 'This helps limit automated accounts and bulk searches.',
  /** The consent-at-claim checkbox, default CHECKED. */
  consentLabel: 'Let people who type this name find my account',
  /** The per-class toggle, after the claim (never implied by the
   * email or phone toggle, nor the reverse). The TITLE is the ruled section
   * heading over the row (the email and phone decks' shape — V3,
   * 2026-10-08: the held state printed the row's label twice); the LABEL is
   * the switch's own line and its spoken name. */
  discoverableTitle: 'Being found by username',
  discoverableLabel: 'Findable by username',
  // Gated on the phone pin like `verificationSummary` (the proof pass,
  // 2026-10-08): a dark class is not named on the glass.
  discoverableNote: PHONE_UI_ENABLED
    ? 'Off means the name stays yours but no one can find your account by typing it. Turning it on or off never changes whether you can be found by email or phone number.'
    : 'Off means the name stays yours but no one can find your account by typing it. Turning it on or off never changes whether you can be found by email.',
  heldUnfindable: 'You hold this name, but no one can find you by it until you turn findability on.',
  /** The same fact on the CLAIM form, BEFORE the name is held: unchecking
   * the box there was rendering "You hold this name" over a name not yet
   * claimed. */
  claimUnfindable:
    'If you claim it with this off, the name is yours but no one can find you by it until you turn findability on.',
  /** The held state's lead: the name this device recorded at claim time —
   * the local row is the ONLY readable home of it (the server stores
   * a keyed hash and never echoes a name). */
  held: (name: string) => `${name} is your username.`,
  /* ── the linked sibling (U1, 2026-10-08) ── */
  /** The group holds a name this device never recorded (the state route's
   * `holdsUsername`): the name itself never travels (§4.9), so the sentence
   * states the fact and what can still be done from here — never the claim
   * form, which would rename the account by accident. */
  heldElsewhere:
    'Your account already has a username, set on another device. This device cannot show it, but you can change or remove it from here.',
  /** This device's row named a username the group no longer holds — a
   * linked sibling removed it. The row is cleared and the person told.
   * Kept for the suites that pin the merged notice's parts; the screen
   * renders the two split sentences below (the proof pass, 2026-10-08:
   * each phantom state knows WHICH happened). */
  phantomCleared: 'Your username was changed or removed from another device.',
  /** A sibling REMOVED the name (holdsUsername false): said as that. */
  phantomRemoved: 'Your username was removed from another device.',
  /** A sibling CHANGED the name (the live row is newer than this one): said
   * as that — the held-elsewhere state follows. */
  phantomRenamed: 'Your username was changed on another device.',
  /* ── the held-elsewhere findability (the proof pass, 2026-10-08) ── */
  /** Over the switch on a sibling: the account's CURRENT bit from the
   * caller-owned state, movable from here (the consent write is group-
   * keyed). */
  heldElsewhereFindability:
    'This switch shows the account’s current setting and can be changed from any linked device.',
  /** The same state while the bit could not be read. */
  heldElsewhereFindabilityUnknown:
    'Whether people can find you by this username could not be read right now. It can be switched from any linked device once it loads.',
  /** The stop-gap on the legacy path (a server without the state route):
   * after a refused claim with no local row, the one thing this device can
   * honestly suggest. */
  heldElsewhereStopGap:
    'If this account already has a username (set on another device), change or remove it from that device.',
  /** Renaming to the name already held (U4): this device's own knowledge,
   * said before any wire call — the server would answer the reasonless 403
   * and charge a claim attempt for a no-op. */
  sameName: 'That is already your username.',
  claim: 'Claim this name',
  rename: 'Change my username',
  /** The rename form's keep verb (the deck's rule: every
   * user-visible literal lives in the deck). */
  renameKeep: 'Keep my current name',
  renameSubmit: 'Change to this name',
  unlink: 'Remove my username',
  unlinkKeep: 'Keep it',
  /** THE ONE distinguishable server answer (the design carve-out: the frozen 409). */
  taken: 'That name is taken — try another.',
  /** EVERY other refusal — the fleet ceiling above all — is the frozen 403,
   * rendered as a generic retry, distinguishable from taken by status
   * alone: this sentence must never say why. */
  tryLater: 'That did not go through. Try again later.',
  failed: 'Could not reach Tacendum. Check your connection and try again.',
  /** The rename cool-down (one change per 30 days, stamped by
   * a rename AND an unlink). Reworded 2026-10-08 (V2): Remove is always
   * accepted — it STARTS the window — and only a different name waits, so
   * the note no longer says removal itself is limited. */
  cooldownNote:
    'A username can change once every 30 days, and removing it counts as a change: after either, a different name has to wait 30 days. Your old name is held for you for 30 days, then freed for anyone.',
  unlinkConfirm:
    'Remove your username? No one will be able to find your account by it. You can take the same name back within 30 days; after that anyone can claim it. A different name will have to wait 30 days.',
  /* ── find by username (the DiscoveryScreen class entry) ── */
  findClass: 'Username',
  /** The class-aware header + accessibility label: with this class selected the surface says what it is. */
  findTitle: 'Find by username',
  findPlaceholder: 'Type a username',
  findNote:
    'Searching by username only finds accounts whose owners chose to be findable this way. Each search is strictly limited.',
  /** The uniform miss (the email class's honesty word for word, named for the class). */
  findNoMatch:
    'No account was found for that username — it may not be on Tacendum, or its owner may not have chosen to be findable. Tacendum cannot tell you which, by design.',
  /** The result card's trust sentence for this class: the same TOFU fact, the class named honestly — and the design
   * consequence said where it bites: the name found someone, it proves
   * nothing about them. */
  findTofu:
    'The first message sets up keys exactly like any new room — being found by username changes who you can reach, never how much they are trusted. A username is not proof of who someone is; the safety number is.',
  /** The why-every-miss explainer for this class: the
   * caller-gate line says the POSSESSION-class gate honestly (a
   * username never buys search rights — only a verified email or phone
   * number on the searcher's own account does). */
  findExplain: [
    'If a miss looked different from “registered but not findable”, typing a username would reveal whether its owner uses Tacendum — without their consent. So every refusal is identical, including the one your own daily search budget causes.',
    // Gated on the phone pin (the proof pass): a dark class is not named.
    PHONE_UI_ENABLED
      ? 'Searching needs a verified email or phone number on your own account — holding a username is not enough. That makes bulk scraping expensive without changing what you see here.'
      : 'Searching needs a verified email on your own account — holding a username is not enough. That makes bulk scraping expensive without changing what you see here.',
  ],
  /* ── the revocation notice (FIXED copy) ── */
  /** Rendered when a `usernameRevoked` notice landed: kind only on the wire,
   * so the sentence states the fact and the two things that follow — and
   * never a reason, because none travels. */
  revokedTitle: 'Your username was removed',
  revokedBody:
    'Tacendum removed the username from your account. Your account, your messages, your rooms and any email or phone number you linked are unchanged; only the name is gone, and no one can find you by it any more. You can claim a different name.',
  revokedDismiss: 'OK',
} as const;
