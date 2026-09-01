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
export const ACCOUNTS_USERNAME_COPY = {
  /** The Settings row (the phone row's shape; mounted only under the pin). */
  settingsRow: 'Username & discovery',
  title: 'Username',
  /** The lead, before the field: what a username is FOR — one purpose. */
  intro:
    'A username is optional. It is a name people can type to find your account — nothing more: it never becomes your login, it is never shown in your chats, and it is never proof of who someone is. Your safety number is the only proof.',
  /** The ⓘ label over the honesty copy: what the disclosure is ABOUT. */
  infoLabel: 'What a username discloses',
  /** THE HONESTY COPY (verbatim — behind the ⓘ). */
  infoLines: [
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
  /** The two preconditions the claim gate enforces, each surfaced
   * up front from THIS device's own knowledge and each with its own
   * sentence (build 24 — simulator testing typed names into thirteen
   * "try again later"s): a name is free to hold, never free to mint. */
  needsIdentifier:
    'Link and verify an email address or phone number first — a username can only be claimed by an account that holds one and is at least three days old. This keeps names from being grabbed by the thousand.',
  /** The age gate, said with the wait left: the account's birth is the
   * server's own stamp on this device's ID, so the device can count. A
   * CONDITION, never a promise: the age is one of several server
   * gates (identifier possession, cool-down, budget, name taken), so this
   * sentence says when the three days end — not that a claim will land. */
  needsAge: (hoursLeft: number) =>
    `Your account needs to be 3 days old to claim a username. Yours is younger — the three days are up in about ${
      hoursLeft >= 48 ? `${Math.round(hoursLeft / 24)} days` : `${hoursLeft} hour${hoursLeft === 1 ? '' : 's'}`
    }.`,
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
  /** The held state's one line on HOW others reach this name (build 24 —
   * testers could not find find-by-username): the finder's door, named. */
  howFound:
    'Others can find you by typing this name in Start a chat → Find by email or username.',
  /* ── the Start a chat door, under the pin (build 24) ── */
  /** The StartChatScreen row, helper and no-directory sentence with the
   * username class live: the door must name what the room offers. A pin-OFF
   * binary renders that screen's own landed literals byte-for-byte. */
  startChatFind: 'Find by email or username',
  startChatFindHelper:
    'Works only for someone who verified an email — or claimed a username — and turned findability on.',
  startChatNoDirectory:
    'Tacendum has no public directory. A chat starts with a Tacendum ID one person hands the other — or with the email or username of someone who chose to be found.',
  /** The consent-at-claim checkbox, default CHECKED. */
  consentLabel: 'Let people who type this name find my account',
  /** The per-class toggle, after the claim (never implied by the
   * email or phone toggle, nor the reverse). */
  discoverableLabel: 'Findable by username',
  discoverableNote:
    'Off means the name stays yours but no one can find your account by typing it. Turning it on or off never changes whether you can be found by email or phone number.',
  heldUnfindable: 'You hold this name, but no one can find you by it until you turn findability on.',
  /** The held state's lead: the name this device recorded at claim time —
   * the local row is the ONLY readable home of it (the server stores
   * a keyed hash and never echoes a name). */
  held: (name: string) => `${name} is your username.`,
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
   * a rename AND an unlink). */
  cooldownNote:
    'You can change or remove your username once every 30 days. After a change, your old name is held for you for 30 days, then freed for anyone.',
  unlinkConfirm:
    'Remove your username? No one will be able to find your account by it. You can take the same name back within 30 days; after that anyone can claim it.',
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
    'The first message sets up keys exactly like any new chat — being found by username changes who you can reach, never how much they are trusted. A username is not proof of who someone is; the safety number is.',
  /** The why-every-miss explainer for this class: the
   * caller-gate line says the POSSESSION-class gate honestly (a
   * username never buys search rights — only a verified email or phone
   * number on the searcher's own account does). */
  findExplain: [
    'If a miss looked different from “registered but not findable”, typing a username would reveal whether its owner uses Tacendum — without their consent. So every refusal is identical, including the one your own daily search budget causes.',
    'Searching needs a verified email or phone number on your own account, and an account at least three days old — holding a username is not enough. That makes bulk scraping expensive without changing what you see here.',
  ],
  /* ── the revocation notice (FIXED copy) ── */
  /** Rendered when a `usernameRevoked` notice landed: kind only on the wire,
   * so the sentence states the fact and the two things that follow — and
   * never a reason, because none travels. */
  revokedTitle: 'Your username was removed',
  revokedBody:
    'Tacendum removed the username from your account. Your account, your messages, your chats and any email or phone number you linked are unchanged; only the name is gone, and no one can find you by it any more. You can claim a different name.',
  revokedDismiss: 'OK',
} as const;
