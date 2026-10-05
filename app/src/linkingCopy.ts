import { DEVICE_NOUN, type DeviceSlotClass } from './deviceNoun';

/**
 * The device-linking copy deck — one deck for the
 * three linking surfaces, consent-grade, and deliberately PURE: no api, no
 * db, no react-native beyond the noun token, so device-noun.test.ts can load
 * it per idiom exactly as it loads blocking/safety/vault (the device-noun
 * discipline). Every device-naming sentence interpolates `DEVICE_NOUN` —
 * hardcoding any device noun here fails that suite on the idioms it lies to.
 */
export const LINKING_COPY = {
  /** Scan side, before the camera: what scanning does and does not do. */
  scanIntro:
    'Scan the code the new device is showing. Nothing links yet — a scanned ID alone can never join your devices.',
  /** Scan side, code on screen: the dual-confirmation instruction (the existing device confirms FIRST). */
  codeInstruction: `Compare this code with the one on the new device. If every group matches, confirm here on this ${DEVICE_NOUN} first, then on the new device.`,
  /** New-device side, code on screen. `who` is the offerer's `shortId`
   * ("…K3MQ") — the "who is asking" rendering, said as what it is: a
   * device, named by its ID (the older sentence read the ID as a person's
   * name). */
  codeInstructionNew: (who: string) =>
    `The device with ID ${who} wants to link this one to its account. Compare the code on both screens — confirm only if every group matches.`,
  /** The stall, stated (shown while waiting for the other side). */
  waiting:
    'Waiting for the new device to confirm. Nothing is linked until it does — both devices confirm one code, and both keys sign.',
  /** The pinned history-stance sentence, verbatim — byte-pinned by the
   * link-ceremony suite; do not reword casually. */
  historyStance: 'This device shows messages from today forward.',
  /** New-device side, refused because this install is lived-in (client half). */
  notPristine: `This ${DEVICE_NOUN} already has a life of its own — rooms, machines, or consent decisions. Only a fresh install can be linked, so nothing it holds can leak into another account's devices.`,
  /** Roster screen: the amicable removal. */
  unlinkConfirm: (name: string) =>
    `Unlink ${name}? It keeps what it already received and continues as its own account. Your other devices stop sending to it.`,
  /** Roster screen: the lost/stolen removal (honest cost stated). */
  revokeConfirm: (name: string) =>
    `Revoke ${name}? Its key can never sign in again. It keeps what it already received — revoking stops anything new from reaching it, it cannot take back the past.`,
  /** Per-device drill-down: the list is local truth, per device (a
   * human act is never propagated). Reworded deliberately: the old
   * sentence promised a verification act this screen does not offer. */
  verificationLocal: `This list is this ${DEVICE_NOUN}'s own record of your devices. Each device keeps its own list — nothing here is copied between them.`,
  /** The collapsed refusal, rendered honestly: the server deliberately does
   * not say which condition refused. */
  refused:
    'That did not work. The link may have expired, or the slot may be taken — start again from the new device.',
  /** The offer ran out before the new device confirmed: said as what it is,
   * never dressed as the collapsed refusal above. */
  expired:
    'The request expired before the new device confirmed it. Start again from the new device.',
  /** A TRANSPORT failure — offline, DNS, a timeout — and never the server's
   * refusal: the refused sentence above would blame an expired link for a
   * request that never arrived. The account decks' sentence, byte-for-byte.
   */
  transportFailed: 'Could not reach Tacendum. Check your connection and try again.',
  /** The scan side's reading failures, per class — the class is the
   * contract, never the thrown text. The photo sentences are
   * StartChatScreen's, byte-for-byte: the same iOS condition must never get
   * two different sentences. */
  cameraFailed:
    'Tacendum couldn’t use the camera. Check that Tacendum has camera access in Settings, or choose a photo of the code instead.',
  photosDenied:
    'Tacendum doesn’t have access to your photos. You can turn it on in Settings.',
  photoTooBig: 'That photo is too large to read. Choose a smaller one.',
  photoUnreadable: 'Tacendum couldn’t read that photo. Choose another one.',
  photoNoCode:
    'There’s no QR code in that photo. Choose the picture the new device is showing, or scan it with the camera instead.',
  qrMultiple:
    'That photo has more than one QR code. Tacendum won’t guess which one is the new device’s — choose a photo with a single code.',
  /** The waiting phase: the offer's own clock, what a mismatch on the other
   * screen means, and the honest shape of stopping — the server has no
   * withdrawal route, so stopping is said as what it is. */
  expiresIn: (clock: string) => `Expires in ${clock}`,
  mismatchHint:
    'If the new device says the codes don’t match, this request will simply expire.',
  stopWaiting: 'Stop waiting',
  stopWaitingHint:
    'Stopping here does not withdraw the request — it expires on its own. If the new device confirms before then, it appears under Linked devices, where you can unlink it.',
  /** No verification code could be derived: the
   * ceremony refuses rather than rendering a blank code region. */
  noCode:
    'A verification code could not be built for these two devices. Nothing was confirmed and nothing linked — start again from the other device.',
  /** Scan side: the slot the offer declares for the new device (the
   * offering device declares; in v1 the only slot a link can occupy is the
   * one this device is not). `slot` interpolates via `slotLabel` — the
   * invariant: slot words are never spelled outside deviceNoun.ts. */
  newDeviceSlot: (slot: string) =>
    `The new device will join as the account's ${slot}. An account holds one of each kind.`,
  /** New-device side, above the confirm: what the acceptance signature
   * asserts about THIS device (a signed slot assertion the
   * signer cannot read is not consent). */
  slotAssertion: (slot: string) => `This ${DEVICE_NOUN} will join as the account's ${slot}.`,
  /** New-device side: the offer names a slot class this device is not — in
   * v1 that means both devices occupy the same class, and the ceremony is
   * refused honestly instead of signing a falsehood. */
  classMismatch: `This ${DEVICE_NOUN} is the same kind of device as the one that sent the request. An account links one of each kind — two of the same kind cannot be linked.`,
  /** The one chokepoint for slot words that reach glass: a
   * ROSTER row names a remote device of unknown platform, so the slot value
   * itself — spelled only in deviceNoun.ts — is the
   * never-wrong generic; every sentence about THIS device speaks the idiom
   * noun above. */
  slotLabel: (slot: DeviceSlotClass | 'desktop'): string => slot,
  /** The ONE Settings row that opens the roster. Lives in the
   * deck, not in SettingsScreen's COPY, so the label rides the same
   * chokepoint as every other linking sentence: "devices" is the generic
   * plural the deck already speaks — no idiom noun, deliberately, because
   * the row names the ACCOUNT's devices, never this one. */
  settingsRow: 'Linked devices',
} as const;
